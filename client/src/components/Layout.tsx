import { Link, useLocation } from "wouter";
import { LayoutDashboard, Settings, TrendingUp, Menu, X } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/settings", label: "Settings", icon: Settings },
];

function Logo() {
  return (
    <svg viewBox="0 0 32 32" width="28" height="28" aria-label="Hot 100 logo" fill="none">
      <circle cx="16" cy="16" r="14" fill="hsl(4 90% 58% / 0.15)" stroke="hsl(4 90% 58%)" strokeWidth="1.5"/>
      <path d="M10 22 C10 16, 14 12, 16 10 C18 12, 22 16, 22 22" stroke="hsl(4 90% 58%)" strokeWidth="2" fill="none" strokeLinecap="round"/>
      <path d="M13 22 C13 19, 14.5 17, 16 15 C17.5 17, 19 19, 19 22" stroke="hsl(38 92% 55%)" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
      <circle cx="16" cy="22" r="2" fill="hsl(38 92% 55%)"/>
    </svg>
  );
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-56 flex flex-col border-r border-border bg-[hsl(var(--sidebar-background))] transition-transform duration-200",
          "md:relative md:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {/* Logo */}
        <div className="flex items-center gap-3 px-5 py-5 border-b border-border">
          <Logo />
          <div>
            <div className="text-sm font-bold text-foreground tracking-tight">HOT 100</div>
            <div className="text-xs text-muted-foreground">Creator Discovery</div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-3 space-y-1">
          {navItems.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setMobileOpen(false)}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors",
                location === href
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary"
              )}
            >
              <Icon size={16} />
              {label}
            </Link>
          ))}
        </nav>

        {/* Footer */}
        <div className="p-4 border-t border-border">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <TrendingUp size={12} className="text-primary" />
            <span>Weekly · YouTube · TikTok · Instagram</span>
          </div>
        </div>
      </aside>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile header */}
      <div className="fixed top-0 left-0 right-0 z-30 flex items-center gap-3 px-4 py-3 bg-background border-b border-border md:hidden">
        <button
          data-testid="button-mobile-menu"
          onClick={() => setMobileOpen(!mobileOpen)}
          className="text-muted-foreground hover:text-foreground"
        >
          {mobileOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
        <Logo />
        <span className="text-sm font-bold">HOT 100</span>
      </div>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto pt-0 md:pt-0">
        <div className="md:hidden h-12" />
        {children}
      </main>
    </div>
  );
}
