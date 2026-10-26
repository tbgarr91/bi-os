import { format, money } from "@bi-os/core";

export default function Home() {
  // M0 placeholder: proves the shared core runs inside the web app. No data, no sign-in.
  return (
    <main>
      <h1>BI OS</h1>
      <p>Pre-release skeleton (Milestone M0). Nothing is connected and no data is stored.</p>
      <p>Core check: {format(money(2266, "USD"))}</p>
    </main>
  );
}
