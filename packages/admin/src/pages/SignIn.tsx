export function SignIn() {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-100 p-6">
      <div className="w-full max-w-md">
        <div className="mb-3 rounded-lg border border-slate-200 bg-white px-4 py-3 text-center text-sm text-slate-600">
          You were sent here because you have no valid session. After sign-in, you return to the admin page.
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-4 text-lg font-semibold">
            plugbricks <span className="font-normal text-slate-500">admin</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Sign in</h1>
          <p className="mt-1 text-sm text-slate-500">Realm: plugbricks</p>
          <a
            href="/auth/login"
            className="mt-6 block rounded-md bg-blue-600 px-4 py-2.5 text-center text-sm font-medium text-white hover:bg-blue-700"
          >
            Sign in
          </a>
          <p className="mt-4 text-xs leading-5 text-slate-500">
            Access needs the <strong>plugbricks-viewer</strong> role to read, or <strong>plugbricks-admin</strong> to change bricks. Without
            either, you see a refusal page, never the admin.
          </p>
        </div>
        <p className="mt-4 text-center text-xs text-slate-500">Identity provider: OIDC (any compatible issuer, for example Keycloak)</p>
      </div>
    </main>
  );
}
