import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { LogOut, Menu, X } from 'lucide-react';

export type NavItem = {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number }>;
};

type Props = {
  brand: ReactNode;
  items: readonly NavItem[];
  activeId: string;
  ownerName: string;
  onSignOut: () => void;
};

/**
 * Whether the inline navigation still fits the header.
 *
 * The header is measured rather than switched at a fixed breakpoint, so it collapses at the
 * width where its content really stops fitting. That width moves with the number of navigation
 * items (a Projects entry needs no new breakpoint), the user's text size and browser zoom.
 * Collapsing only ever swaps the inline links for a disclosed menu; nothing is clipped.
 *
 * `requiredWidth` is the width the inline layout needed when it last overflowed. The header
 * expands again only once it is at least that wide, which gives the switch hysteresis and
 * prevents flicker at the threshold.
 */
function useCollapsedNavigation(
  headerRef: { current: HTMLElement | null },
  navRef: { current: HTMLElement | null },
  itemCount: number,
) {
  const [collapsed, setCollapsed] = useState(false);
  const requiredWidth = useRef(0);

  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return undefined;
    // A state update from an observer callback commits after the frame that triggered it. During a
    // live resize that can show one frame of the previous layout; committing synchronously from
    // inside the callback would raise the browser's "ResizeObserver loop" error instead.
    const measure = () => {
      if (!collapsed) {
        if (header.scrollWidth > header.clientWidth) {
          requiredWidth.current = header.scrollWidth;
          setCollapsed(true);
        }
      } else if (header.clientWidth >= requiredWidth.current + 1) {
        setCollapsed(false);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    // The inline list also resizes when its entries change, without the header changing width.
    if (!collapsed && navRef.current) observer.observe(navRef.current);
    // A late font swap changes the inline width without resizing the header.
    let active = true;
    void document.fonts?.ready.then(() => {
      if (active) measure();
    });
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [collapsed, headerRef, navRef, itemCount]);

  return collapsed;
}

export function AppHeader({ brand, items, activeId, ownerName, onSignOut }: Props) {
  const headerRef = useRef<HTMLElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const navRef = useRef<HTMLElement | null>(null);
  const menuId = useId();
  const collapsed = useCollapsedNavigation(headerRef, navRef, items.length);
  const [open, setOpen] = useState(false);
  const expanded = collapsed && open;

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  // Growing back to the inline layout dismisses the menu.
  useEffect(() => {
    if (!collapsed) setOpen(false);
  }, [collapsed]);

  // Browser back/forward and any programmatic route change dismiss the menu. Focus returns to
  // the button when it was inside the panel, because the focused link is about to be hidden.
  useEffect(() => {
    setOpen(false);
    if (navRef.current?.contains(document.activeElement)) buttonRef.current?.focus();
  }, [activeId]);

  // Outside pointer presses dismiss the menu without moving focus.
  useEffect(() => {
    if (!expanded) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (headerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [expanded]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && expanded) {
      event.stopPropagation();
      close(true);
    }
  };

  const nav = (
    <nav
      ref={navRef}
      id={menuId}
      className="primary-nav"
      aria-label="Primary navigation"
      data-collapsed={collapsed ? 'true' : undefined}
      hidden={collapsed && !open}
      onBlur={(event) => {
        // Tabbing out of an open panel closes it; focus has already moved on.
        if (!expanded) return;
        const next = event.relatedTarget as Node | null;
        if (next && (navRef.current?.contains(next) || buttonRef.current?.contains(next))) return;
        setOpen(false);
      }}
    >
      {items.map((item) => (
        <a
          key={item.id}
          href={`#${item.id}`}
          aria-current={activeId === item.id ? 'page' : undefined}
          className={activeId === item.id ? 'nav-active' : ''}
          onClick={() => {
            if (collapsed) close(true);
          }}
        >
          <item.icon size={16} />
          <span>{item.label}</span>
        </a>
      ))}
    </nav>
  );

  return (
    <header
      ref={headerRef}
      className="topbar"
      data-nav={collapsed ? 'menu' : 'inline'}
      onKeyDown={onKeyDown}
    >
      {brand}
      {!collapsed && nav}
      <div className="topbar-actions">
        <div className="owner-chip">
          <span className="owner-avatar" aria-hidden="true">
            {ownerName.slice(0, 1)}
          </span>
          <span>{ownerName}</span>
        </div>
        {collapsed && (
          <>
            <button
              ref={buttonRef}
              type="button"
              className="icon-button menu-button"
              aria-label="Navigation menu"
              aria-expanded={expanded}
              aria-controls={menuId}
              onClick={() => setOpen((value) => !value)}
            >
              {expanded ? <X size={18} /> : <Menu size={18} />}
            </button>
            {/* Directly after its button in tab order; positioned against the header. */}
            {nav}
          </>
        )}
        <button className="icon-button" onClick={onSignOut} aria-label="Sign out" title="Sign out">
          <LogOut size={17} />
        </button>
      </div>
    </header>
  );
}
