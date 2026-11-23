import { NavLink, Outlet } from "react-router-dom";
import type { Session } from "../types.js";

const link = ({ isActive }: { isActive: boolean }) =>
  `block rounded-md px-3 py-2 text-sm ${isActive ? "bg-blue-50 font-medium text-blue-700" : "text-slate-600 hover:bg-slate-100"}`;

export function Layout({ session }: { session: Session }) {
  return (
    // A column the height of the window: the menu and the page fill what the header leaves, so the menu reaches the bottom.
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between bg-[#0b1729] px-6 py-3 text-white">
        <span className="text-lg font-semibold">
          plugbricks <span className="font-normal text-slate-300">admin</span>
        </span>
        <div className="flex items-center gap-2 text-xs">
          <span className="rounded bg-white/10 px-2 py-1">
            runtime: {session.runtime} · project: {session.project}
          </span>
          <span className="rounded bg-white/10 px-2 py-1">
            {session.dev ? "dev" : session.name || "user"} · role: {session.role}
          </span>
        </div>
      </header>
      <div className="flex flex-1">
        <nav className="w-52 shrink-0 border-r border-slate-200 bg-white p-3">
          <NavLink to="/" end className={link}>
            Bricks
          </NavLink>
          <NavLink to="/router" className={link}>
            Router
          </NavLink>
          <NavLink to="/audit" className={link}>
            Audit log
          </NavLink>
          <form method="post" action="/auth/logout" className="mt-6">
            <button type="submit" className="block w-full rounded-md px-3 py-2 text-left text-sm text-slate-600 hover:bg-slate-100">
              Sign out
            </button>
          </form>
        </nav>
        <main className="min-w-0 flex-1 bg-slate-50 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
