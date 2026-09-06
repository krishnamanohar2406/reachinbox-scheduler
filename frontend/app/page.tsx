"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { GoogleLogin, CredentialResponse } from "@react-oauth/google";
import { api, saveSession, hasSession } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();

  useEffect(() => {
    if (hasSession()) router.replace("/dashboard");
  }, [router]);

  async function handleSuccess(credential: CredentialResponse) {
    if (!credential.credential) return;
    try {
      const { token } = await api.loginWithGoogle(credential.credential);
      saveSession(token);
      router.replace("/dashboard");
    } catch (err) {
      console.error(err);
      alert("Login failed. Please try again.");
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4">
      <div className="flex flex-col items-center gap-2">
        <div className="h-12 w-12 rounded-xl bg-brand-600" />
        <h1 className="text-2xl font-semibold text-slate-900">ReachInbox Scheduler</h1>
        <p className="text-sm text-slate-500">Sign in to manage your email campaigns</p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <GoogleLogin onSuccess={handleSuccess} onError={() => alert("Google login failed")} />
      </div>
    </main>
  );
}
