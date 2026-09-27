import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  isSquadronCreateOpen,
  openSquadronCreate,
  resolveAddProjectDoor,
  setSquadronCreateOpen,
  subscribeSquadronCreateOpen,
} from "./SquadronCreateRequest";

afterEach(() => setSquadronCreateOpen(false));

describe("Create Squadron open requests", () => {
  it("holds a request until the dialog closes, so a host that mounts later still opens", () => {
    openSquadronCreate();
    expect(isSquadronCreateOpen()).toBe(true);
    setSquadronCreateOpen(false);
    expect(isSquadronCreateOpen()).toBe(false);
  });

  it("notifies only on a real change", () => {
    let notified = 0;
    const unsubscribe = subscribeSquadronCreateOpen(() => {
      notified += 1;
    });
    openSquadronCreate();
    openSquadronCreate();
    setSquadronCreateOpen(false);
    unsubscribe();
    openSquadronCreate();
    expect(notified).toBe(2);
  });
});

describe("resolveAddProjectDoor", () => {
  it("opens Create Squadron when no J5 flow asked for a folder back", () => {
    expect(resolveAddProjectDoor({ onProjectSelected: undefined, sourcePicker: undefined })).toBe(
      "create-squadron",
    );
  });

  it("browses for a folder when Create Squadron or a source picker is waiting for one", () => {
    expect(resolveAddProjectDoor({ onProjectSelected: () => {}, sourcePicker: undefined })).toBe(
      "pick-folder",
    );
    expect(resolveAddProjectDoor({ onProjectSelected: undefined, sourcePicker: {} })).toBe(
      "pick-folder",
    );
  });
});
