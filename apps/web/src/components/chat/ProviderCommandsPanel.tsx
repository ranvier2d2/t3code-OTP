import { memo, useState, useCallback, useRef, useEffect } from "react";
import type { ProviderCommand } from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import { ZapIcon, SearchIcon } from "lucide-react";

interface ProviderCommandsPanelProps {
  commands: ProviderCommand[];
  onSelectCommand: (commandName: string) => void;
  onClose: () => void;
}

const TYPE_LABELS: Record<string, string> = {
  builtin: "Builtin",
  user: "User Skills",
  project: "Project",
  other: "Other",
};

const TYPE_ORDER = ["builtin", "project", "user", "other"] as const;

export const ProviderCommandsPanel = memo(function ProviderCommandsPanel({
  commands,
  onSelectCommand,
  onClose,
}: ProviderCommandsPanelProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = commands.filter((cmd) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      cmd.name.toLowerCase().includes(q) ||
      cmd.description.toLowerCase().includes(q)
    );
  });

  const grouped = TYPE_ORDER.map((type) => ({
    type,
    label: TYPE_LABELS[type] ?? type,
    items: filtered.filter((c) => c.type === type),
  })).filter((g) => g.items.length > 0);

  const flatItems = grouped.flatMap((g) => g.items);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const handleSelect = useCallback(
    (cmd: ProviderCommand) => {
      onSelectCommand(cmd.name);
      onClose();
    },
    [onSelectCommand, onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIndex((i) => Math.min(i + 1, flatItems.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setActiveIndex((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          if (flatItems[activeIndex]) handleSelect(flatItems[activeIndex]);
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [flatItems, activeIndex, handleSelect, onClose],
  );

  // Scroll active item into view
  useEffect(() => {
    const activeEl = listRef.current?.querySelector(
      `[data-command-index="${activeIndex}"]`,
    );
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  let flatIndex = 0;

  return (
    <div
      className="w-80 overflow-hidden rounded-xl border border-border/80 bg-popover/96 shadow-lg/8 backdrop-blur-xs"
      role="dialog"
      aria-label="Provider commands"
      onKeyDown={handleKeyDown}
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <SearchIcon className="size-3.5 text-muted-foreground/60" />
        <input
          ref={searchRef}
          type="text"
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
          placeholder="Search commands..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search provider commands"
          aria-controls="provider-commands-list"
          aria-activedescendant={
            flatItems[activeIndex]
              ? `cmd-${flatItems[activeIndex].name}`
              : undefined
          }
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
        />
      </div>

      <div
        ref={listRef}
        id="provider-commands-list"
        role="listbox"
        aria-label="Available commands"
        className="max-h-72 overflow-y-auto"
      >
        {grouped.map((group) => (
          <div key={group.type}>
            <div className="sticky top-0 bg-popover/96 px-3 py-1.5 font-medium text-muted-foreground/60 text-[10px] uppercase tracking-wider backdrop-blur-xs">
              {group.label}
            </div>
            {group.items.map((cmd) => {
              const idx = flatIndex++;
              return (
                <div
                  key={cmd.name}
                  id={`cmd-${cmd.name}`}
                  data-command-index={idx}
                  role="option"
                  aria-selected={idx === activeIndex}
                  className={cn(
                    "flex cursor-pointer select-none items-center gap-2 px-3 py-1.5",
                    idx === activeIndex
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-accent/50",
                  )}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => handleSelect(cmd)}
                >
                  <ZapIcon className="size-3 shrink-0 text-muted-foreground/60" />
                  <span className="font-mono text-xs">/{cmd.name}</span>
                  {cmd.description ? (
                    <span className="min-w-0 truncate text-muted-foreground/60 text-xs">
                      {cmd.description}
                    </span>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}

        {flatItems.length === 0 ? (
          <p className="px-3 py-3 text-center text-muted-foreground/60 text-xs">
            {query ? "No matching commands." : "No commands available."}
          </p>
        ) : null}
      </div>
    </div>
  );
});
