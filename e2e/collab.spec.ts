import { test, expect, type Browser, type Page } from "@playwright/test";

/**
 * Live-collaboration E2E (docs/collab-protocol.md §3/§4/§7).
 *
 * Two browser guests join the same room through the reference relay in
 * `e2e/fixtures/relay.mjs` (which also serves `dist/`). There is no desktop
 * host here, so the first guest answers the second's SYNC_REQUEST.
 */

const RELAY = "http://127.0.0.1:4174";
// The Rust relay exposes its test-only `/__end` hook on a separate port.
const CONTROL = process.env.COLLAB_RELAY === "rust" ? "http://127.0.0.1:4175" : RELAY;
const ROOM = "0123456789abcdef0123";
const KEY = "AAAAAAAAAAAAAAAAAAAAAA";
const ROOM_URL = `${RELAY}/#room=${ROOM},${KEY}`;

// The relay's room table is shared state; keep these tests serial.
test.describe.configure({ mode: "serial" });

async function openGuest(browser: Browser, name: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await context.addInitScript((n) => {
    localStorage.setItem("excalidraw-desktop:guest-name", n);
    localStorage.setItem("excalidraw-desktop:e2e", "1");
  }, name);
  const page = await context.newPage();
  await page.goto(ROOM_URL);
  await expect(page.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => window.__guest?.session?.currentStatus === "connected");
  return page;
}

const peerCount = (page: Page) => page.evaluate(() => window.__guest?.session?.peers.length ?? 0);

test.describe("live collaboration — browser guests", () => {
  test("syncs drawn elements and renders remote cursors", async ({ browser }) => {
    const alice = await openGuest(browser, "Alice");
    const bob = await openGuest(browser, "Bob");
    await expect.poll(() => peerCount(alice)).toBe(1);
    await expect.poll(() => peerCount(bob)).toBe(1);

    // Alice draws a rectangle with the real tool.
    const canvas = alice.locator("canvas.interactive");
    await canvas.click({ position: { x: 600, y: 600 } });
    await alice.keyboard.press("r");
    await alice.mouse.move(300, 300);
    await alice.mouse.down();
    await alice.mouse.move(380, 360, { steps: 5 });
    await alice.mouse.move(460, 420, { steps: 5 });
    await alice.mouse.up();

    const drawn = await alice.evaluate(() => {
      const el = window.__guest!.api.getSceneElements()[0];
      return { id: el.id, version: el.version };
    });
    await bob.waitForFunction(
      ({ id, version }) =>
        window.__guest?.api
          .getSceneElements()
          .some((e) => e.id === id && e.type === "rectangle" && e.version >= version),
      drawn,
    );

    // Bob deletes it; the deletion propagates back to Alice.
    await bob.evaluate(() => {
      const api = window.__guest!.api;
      api.updateScene({
        elements: api
          .getSceneElementsIncludingDeleted()
          .map((e) => ({ ...e, isDeleted: true, version: e.version + 1, versionNonce: 1 })),
      });
    });
    await alice.waitForFunction(() => window.__guest?.api.getSceneElements().length === 0);

    // Alice's pointer shows up as a named collaborator on Bob's side.
    await alice.mouse.move(500, 300);
    await alice.mouse.move(520, 320, { steps: 4 });
    await bob.waitForFunction(() =>
      [...(window.__guest?.api.getAppState().collaborators.values() ?? [])].some(
        (c) => c.username === "Alice" && c.pointer !== undefined,
      ),
    );
    await expect(bob.getByTestId("guest-session-btn")).toHaveText(/Live\s*2/);

    await alice.context().close();
    await bob.waitForFunction(() => window.__guest?.api.getAppState().collaborators.size === 0);
    await bob.context().close();
  });

  test("a demoted guest becomes view-only until promoted again", async ({ browser, request }) => {
    const alice = await openGuest(browser, "Alice");
    const bob = await openGuest(browser, "Bob");
    await expect.poll(() => peerCount(alice)).toBe(1);
    const bobId = await alice.evaluate(() => window.__guest!.session!.peers[0].clientId);

    const setRole = async (role: "editor" | "viewer") =>
      expect((await request.post(`${CONTROL}/__role/${ROOM}/${bobId}/${role}`)).status()).toBe(204);

    await setRole("viewer");
    await expect(bob.getByTestId("viewer-bar")).toBeVisible();
    await expect(bob.getByTestId("ask-to-edit")).toBeVisible();
    await expect
      .poll(() => bob.evaluate(() => window.__guest!.api.getAppState().viewModeEnabled))
      .toBe(true);
    await expect
      .poll(() => alice.evaluate(() => window.__guest!.session!.peers[0].role))
      .toBe("viewer");

    // A viewer's scene changes never reach other peers.
    await bob.evaluate(() =>
      window.__guest!.session!.onSceneChange([
        {
          id: "forged",
          type: "rectangle",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          angle: 0,
          version: 1,
          versionNonce: 1,
          isDeleted: false,
          index: "a0",
        } as never,
      ]),
    );
    await alice.waitForTimeout(500);
    expect(await alice.evaluate(() => window.__guest!.api.getSceneElements().length)).toBe(0);

    await setRole("editor");
    await expect(bob.getByTestId("viewer-bar")).toBeHidden();
    await expect
      .poll(() => bob.evaluate(() => window.__guest!.api.getAppState().viewModeEnabled))
      .toBe(false);

    await alice.context().close();
    await bob.context().close();
  });

  test("shows the session-ended banner when the room closes", async ({ browser, request }) => {
    const carol = await openGuest(browser, "Carol");
    const res = await request.post(`${CONTROL}/__end/${ROOM}`);
    expect(res.status()).toBe(204);
    await expect(carol.getByRole("status")).toHaveText(/host ended this session/);
    await carol.context().close();
  });
});
