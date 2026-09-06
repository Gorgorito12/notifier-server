import test from "node:test";
import assert from "node:assert/strict";
import { resolveLatestVersion } from "./github.js";
import type { TrackedMod } from "./config.js";

/**
 * The version path had NO tests at all, and CI never ran the suite that existed. That
 * combination is how this service could have announced a release the launcher refuses to
 * install, for months, with nothing to notice it.
 *
 * Two rules are load-bearing here, and both are about not out-running the launcher:
 *
 *  1. `followLatest` is OPT-IN in the catalog schema. A mod without it installs its
 *     `approvedReleaseTag` and nothing else, so announcing any other tag announces a
 *     version that will never be resolved.
 *  2. `followLatest` mods resolve through `/repos/{repo}/releases/latest`, the same
 *     endpoint the launcher uses. GitHub excludes drafts AND prereleases from it. Paging
 *     `/releases` and taking the first non-draft — what this used to do — accepts
 *     prereleases and diverges.
 */

function mod(extra: Partial<TrackedMod> = {}): TrackedMod {
  return {
    id: "improvement-mod",
    updateMechanism: "GitHubReleases",
    githubRepo: "mandosrex/AoE3ImpMod_New",
    approvedReleaseTag: "19.07.2026",
    followLatest: true,
    ...extra,
  };
}

/** Stubs global fetch. The point is the resolution rules, not the network. */
function withFetch(
  handler: (url: string) => { ok: boolean; status: number; body?: unknown },
  fn: () => Promise<void>,
): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const res = handler(String(input));
    return { ok: res.ok, status: res.status, json: async () => res.body };
  }) as unknown as typeof fetch;
  return fn().finally(() => { globalThis.fetch = real; });
}

const ok = (body: unknown) => () => ({ ok: true, status: 200, body });
const fails = (status: number) => () => ({ ok: false, status });

// --- rule 1: followLatest is opt-in ------------------------------------------

test("followLatest off — the approved tag is the answer, and GitHub is not asked", async () => {
  let called = false;
  await withFetch(() => { called = true; return { ok: true, status: 200, body: {} }; }, async () => {
    const out = await resolveLatestVersion(mod({ followLatest: false }), "");
    assert.equal(out, "19.07.2026");
  });
  assert.equal(called, false, "a pinned mod must not cost an API call either");
});

test("followLatest absent is the same as off — the catalog field is opt-in", async () => {
  await withFetch(ok({ tag_name: "99.99.9999" }), async () => {
    const out = await resolveLatestVersion(mod({ followLatest: undefined }), "");
    assert.equal(out, "19.07.2026");
  });
});

// --- rule 2: the same endpoint the launcher uses -----------------------------

test("followLatest on — reads /releases/latest, which excludes prereleases", async () => {
  let seen = "";
  await withFetch((url) => { seen = url; return { ok: true, status: 200, body: { tag_name: "06.09.2026" } }; },
    async () => {
      const out = await resolveLatestVersion(mod(), "");
      assert.equal(out, "06.09.2026");
    });
  assert.equal(seen, "https://api.github.com/repos/mandosrex/AoE3ImpMod_New/releases/latest");
  assert.ok(!seen.includes("per_page"), "paging /releases would let a prerelease through");
});

test("the tag is trimmed", async () => {
  await withFetch(ok({ tag_name: "  06.09.2026 \n" }), async () => {
    assert.equal(await resolveLatestVersion(mod(), ""), "06.09.2026");
  });
});

// --- failure is never silent, and never worse than the approved tag ----------

test("no published release (404) falls back to the approved tag", async () => {
  await withFetch(fails(404), async () => {
    assert.equal(await resolveLatestVersion(mod(), ""), "19.07.2026");
  });
});

test("a rate-limited poll falls back to the approved tag, not to nothing", async () => {
  await withFetch(fails(403), async () => {
    assert.equal(await resolveLatestVersion(mod(), ""), "19.07.2026");
  });
});

test("an empty tag_name falls back to the approved tag", async () => {
  await withFetch(ok({ tag_name: "" }), async () => {
    assert.equal(await resolveLatestVersion(mod(), ""), "19.07.2026");
  });
});

test("a thrown fetch does not take the poll down", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
  try {
    assert.equal(await resolveLatestVersion(mod(), ""), "");
  } finally {
    globalThis.fetch = real;
  }
});

test("no repo and no approved tag is the only case that yields nothing", async () => {
  await withFetch(ok({}), async () => {
    const out = await resolveLatestVersion(
      mod({ githubRepo: undefined, approvedReleaseTag: undefined }), "");
    assert.equal(out, "");
  });
});

// --- the mechanisms with no version source -----------------------------------

test("Manual and DelegatedExternal have no version source", async () => {
  for (const mechanism of ["Manual", "DelegatedExternal", "SomethingNew"]) {
    await withFetch(ok({ tag_name: "1.0" }), async () => {
      assert.equal(await resolveLatestVersion(mod({ updateMechanism: mechanism }), ""), "");
    });
  }
});
