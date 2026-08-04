import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { FetchedModel } from "@/lib/api/model-fetch";
import { cn } from "@/lib/utils";

export function ModelDropdown({
  models,
  onSelect,
  disabled = false,
  triggerClassName,
}: {
  models: FetchedModel[];
  onSelect: (id: string) => void;
  disabled?: boolean;
  /** 覆写触发按钮尺寸；列表页的模型行需要比表单里更紧凑的按钮。 */
  triggerClassName?: string;
}) {
  const grouped: Record<string, FetchedModel[]> = {};
  for (const model of models) {
    const vendor = model.ownedBy || "Other";
    if (!grouped[vendor]) grouped[vendor] = [];
    grouped[vendor].push(model);
  }
  const vendors = Object.keys(grouped).sort();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className={cn("shrink-0", triggerClassName)}
          disabled={disabled}
        >
          <ChevronDown className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-h-64 overflow-y-auto z-[200]"
      >
        {vendors.map((vendor, vi) => (
          <div key={vendor}>
            {vi > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel>{vendor}</DropdownMenuLabel>
            {grouped[vendor].map((m) => (
              <DropdownMenuItem key={m.id} onSelect={() => onSelect(m.id)}>
                {m.id}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
