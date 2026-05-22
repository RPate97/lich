import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"

interface SiteHeaderProps {
  lastUpdated: number | undefined
  error: string | undefined
}

export function SiteHeader({ lastUpdated, error }: SiteHeaderProps) {
  const pollStatus = error
    ? `poll error: ${error}`
    : lastUpdated
      ? `updated ${Math.round((Date.now() - lastUpdated) / 1000)}s ago`
      : "loading…"

  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator
          orientation="vertical"
          className="mx-2 data-[orientation=vertical]:h-4"
        />
        <h1 className="text-base font-medium">lich dashboard</h1>
        <span className="text-muted-foreground ml-auto text-sm">
          {pollStatus}
        </span>
      </div>
    </header>
  )
}
