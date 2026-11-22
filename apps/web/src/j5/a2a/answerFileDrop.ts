const ATTRIBUTE = "data-j5-file-drop-target";

/** Marks an element that takes dropped files itself, such as a Captain's pinned ask. */
export const ownFileDropTargetProps = { [ATTRIBUTE]: "true" } as const;

/** Whether a drop landed in an element that takes files itself, so the thread must not take them too. */
export const isInsideOwnFileDropTarget = (target: EventTarget | null) =>
  target instanceof Element && target.closest(`[${ATTRIBUTE}]`) !== null;
