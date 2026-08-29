/**
 * The ETag rule. Run: `npm test`.
 *
 * <p><b>Why this file exists for one function.</b> The launchers read this service with
 * `If-None-Match`, so the ETag is the ONLY thing that decides whether anybody ever sees a
 * change. If it fails to move when the content does, the failure is total and completely
 * silent: the service looks healthy, the manifest is correct, every launcher gets a cheap
 * `304`, and nothing is ever delivered. That is exactly what would have happened when
 * announcements were added — the hash covered the mods map alone.</p>
 */
import test from "node:test";
import assert from "node:assert/strict";
import { computeEtag, type Manifest } from "./manifest.js";
import { resolveAnnouncements, type Announcement } from "./github.js";

const MODS: Manifest["mods"] = {
  wol: { latestVersion: "1.2.0e", translations: ["es@abc123"] },
};

const NEWS: Announcement[] = [
  { id: "2026-08-competitive", title: "Competitive rooms", body: "Ranked play is here." },
];

test("the same content yields the same ETag — that is what makes a 304 cheap", () => {
  assert.equal(computeEtag(MODS, NEWS), computeEtag(MODS, NEWS));
});

test("a changed mod version moves the ETag", () => {
  const after: Manifest["mods"] = { wol: { latestVersion: "1.2.0f", translations: ["es@abc123"] } };
  assert.notEqual(computeEtag(MODS, NEWS), computeEtag(after, NEWS));
});

// THE ONE THAT MATTERS. Publishing an announcement without this moving the ETag means every
// launcher is told "nothing changed" and the announcement reaches nobody, forever.
test("a NEW announcement moves the ETag", () => {
  const after = [...NEWS, { id: "2026-09-elo", title: "Rating fixes", body: "" }];
  assert.notEqual(computeEtag(MODS, NEWS), computeEtag(MODS, after));
});

test("EDITING an announcement moves the ETag", () => {
  const after: Announcement[] = [{ ...NEWS[0], title: "Competitive rooms are live" }];
  assert.notEqual(computeEtag(MODS, NEWS), computeEtag(MODS, after));
});

test("removing the last announcement moves the ETag", () => {
  assert.notEqual(computeEtag(MODS, NEWS), computeEtag(MODS, []));
});

/**
 * Mod order must not matter — the poller builds the map by iterating a discovered list, and a
 * reshuffle there would otherwise invalidate every launcher's cache for no reason.
 */
test("the mods map is order-independent", () => {
  const a: Manifest["mods"] = {
    wol: { latestVersion: "1", translations: ["x"] },
    "improvement-mod": { latestVersion: "2", translations: ["y"] },
  };
  const b: Manifest["mods"] = {
    "improvement-mod": { latestVersion: "2", translations: ["y"] },
    wol: { latestVersion: "1", translations: ["x"] },
  };
  assert.equal(computeEtag(a, []), computeEtag(b, []));
});

/** Calling it the old way still works, so nothing that has not been updated silently breaks. */
test("omitting announcements is allowed and stable", () => {
  assert.equal(computeEtag(MODS), computeEtag(MODS, []));
});

// --- what the server refuses to publish --------------------------------------
//
// Stubs global fetch: the point is the parsing rules, not the network.

function withFetch(body: unknown, fn: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof fetch;
  return fn().finally(() => { globalThis.fetch = real; });
}

test("an entry with no id is dropped — it would bell on every poll, forever", async () => {
  await withFetch({ announcements: [
    { title: "No id here", body: "" },
    { id: "ok", title: "Fine", body: "" },
  ] }, async () => {
    const out = await resolveAnnouncements("owner/repo", "announcements.json", "");
    assert.deepEqual(out.map((a) => a.id), ["ok"]);
  });
});

test("an entry with no title is dropped — it would render as a blank row", async () => {
  await withFetch({ announcements: [{ id: "x", body: "orphan" }] }, async () => {
    assert.deepEqual(await resolveAnnouncements("owner/repo", "announcements.json", ""), []);
  });
});

test("a file with no announcements array is not an error", async () => {
  await withFetch({ _readme: ["notes"] }, async () => {
    assert.deepEqual(await resolveAnnouncements("owner/repo", "announcements.json", ""), []);
  });
});

test("optional fields are omitted rather than emitted empty", async () => {
  await withFetch({ announcements: [{ id: "a", title: "T" }] }, async () => {
    const [a] = await resolveAnnouncements("owner/repo", "announcements.json", "");
    assert.equal(a.body, "");
    assert.equal(a.url, undefined);
  });
});
