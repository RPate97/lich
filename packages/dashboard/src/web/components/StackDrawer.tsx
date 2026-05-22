import { Sheet, SheetContent, SheetHeader, SheetTitle } from './ui/sheet';
import { ServiceRow } from './ServiceRow';
import type { StackView } from '../../types';

/** Detail drawer for one stack: service list + live logs. */
export function StackDrawer({
  stack,
  onClose,
}: {
  stack: StackView | undefined;
  onClose: () => void;
}) {
  return (
    <Sheet open={stack !== undefined} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-xl">
        {stack ? (
          <>
            <SheetHeader>
              <SheetTitle>{stack.branch}</SheetTitle>
              <p className="text-muted-foreground text-xs">{stack.path}</p>
            </SheetHeader>
            <div className="mt-4">
              {stack.worktreeMissing ? (
                <p className="text-muted-foreground text-sm">
                  Worktree path no longer exists on disk.
                </p>
              ) : stack.services.length === 0 ? (
                <p className="text-muted-foreground text-sm">No services.</p>
              ) : (
                stack.services.map((s) => (
                  <ServiceRow key={s.name} stackKey={stack.key} service={s} />
                ))
              )}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
