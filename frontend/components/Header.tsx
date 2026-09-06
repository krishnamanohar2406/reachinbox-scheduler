"use client";

import { useRouter } from "next/navigation";
import { User, clearSession } from "@/lib/api";

export default function Header({ user }: { user: User | null }) {
  const router = useRouter();

  function handleLogout() {
    clearSession();
    router.replace("/");
  }

  return (
    <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-4">
      <div className="flex items-center gap-2">
        <div className="h-8 w-8 rounded-lg bg-brand-600" />
        <span className="text-lg font-semibold text-slate-900">ReachInbox Scheduler</span>
      </div>

      {user && (
        <div className="flex items-center gap-3">
          {user.avatar_url ? (
            <img src={user.avatar_url} alt={user.name ?? user.email} className="h-8 w-8 rounded-full" />
          ) : (
            <div className="h-8 w-8 rounded-full bg-brand-100 text-center text-sm leading-8 text-brand-700">
              {(user.name ?? user.email)[0]?.toUpperCase()}
            </div>
          )}
          <div className="text-sm">
            <p className="font-medium text-slate-900">{user.name ?? "—"}</p>
            <p className="text-slate-500">{user.email}</p>
          </div>
          <button
            onClick={handleLogout}
            className="ml-4 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-50"
          >
            Logout
          </button>
        </div>
      )}
    </header>
  );
}
