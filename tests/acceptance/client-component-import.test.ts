// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { mount, unmount } from "svelte";
import Parent from "../fixtures/client-component/Parent.svelte?client";

it("compiles a nested Svelte import in the client test graph", async () => {
  const target = document.createElement("div");
  const component = mount(Parent, { target });
  try {
    expect(target.querySelector("button")?.textContent).toBe("Nested client component");
  } finally {
    await unmount(component);
  }
});
