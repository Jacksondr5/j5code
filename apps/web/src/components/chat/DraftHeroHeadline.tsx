interface DraftHeroHeadlineProps {
  readonly squadronName: string | null;
}

export function DraftHeroHeadline({ squadronName }: DraftHeroHeadlineProps) {
  return (
    <h1 className="mx-auto w-full max-w-5xl text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
      {squadronName === null ? "What should we build?" : `What should we build in ${squadronName}?`}
    </h1>
  );
}
