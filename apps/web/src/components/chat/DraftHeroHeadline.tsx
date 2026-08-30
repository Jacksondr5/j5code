interface DraftHeroHeadlineProps {
  readonly activeProjectTitle: string | null;
  readonly squadronName: string | null;
}

export function DraftHeroHeadline({ activeProjectTitle, squadronName }: DraftHeroHeadlineProps) {
  return (
    <h1 className="mx-auto w-full max-w-5xl text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
      {activeProjectTitle === null
        ? "Choose a project to start"
        : squadronName === null
          ? `What should we build in ${activeProjectTitle}?`
          : `What should ${squadronName} build in ${activeProjectTitle}?`}
    </h1>
  );
}
