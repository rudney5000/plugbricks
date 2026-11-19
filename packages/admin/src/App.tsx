import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ApiError, getSession } from "./api.js";
import { Layout } from "./components/Layout.js";
import { Audit } from "./pages/Audit.js";
import { Bricks } from "./pages/Bricks.js";
import { RouterPage } from "./pages/Router.js";
import { SignIn } from "./pages/SignIn.js";
import type { Session } from "./types.js";

const anonymous: Session = { authenticated: false, dev: false, role: null, name: "", project: "", runtime: "" };

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSession()
      .then(setSession)
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) setSession(anonymous);
        else setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  if (error)
    return (
      <main className="grid min-h-screen place-items-center p-6 text-sm text-red-700">
        <p>The admin could not be reached: {error}</p>
      </main>
    );
  if (!session)
    return (
      <main className="grid min-h-screen place-items-center text-sm text-slate-500">
        <p>Loading…</p>
      </main>
    );
  if (!session.authenticated) return <SignIn />;

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout session={session} />}>
          <Route index element={<Bricks />} />
          <Route path="router" element={<RouterPage />} />
          <Route path="audit" element={<Audit />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
