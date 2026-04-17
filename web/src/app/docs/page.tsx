import Link from "next/link";
import { InfoNav } from "../_components/InfoNav";
import { InfoFooter } from "../_components/InfoFooter";
import { DocsChatWidget } from "./_components/DocsChatWidget";

const LINE_COLORS = ["#2563eb", "#16a34a", "#dc2626", "#d97706", "#7c3aed", "#0891b2"];

const docCards = [
  {
    href: "/docs/user",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <path d="M12 2C8.13 2 5 5.13 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26C17.81 13.47 19 11.38 19 9c0-3.87-3.13-7-7-7z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M9 21h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
    color: "#2563eb", bg: "#eff6ff",
    title: "User Documentation",
    description: "How to use the map, draw and edit lines, manage stops, run the AI planning council, and import/export GTFS.",
    sections: ["Map Basics", "Lines Panel", "Add Stops", "Neighbourhood Selection", "GTFS Import/Export", "AI Council"],
  },
  {
    href: "/docs/technical",
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <path d="M8 9l-3 3 3 3M16 9l3 3-3 3M14 3l-4 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    color: "#7c3aed", bg: "#f5f3ff",
    title: "Technical Documentation",
    description: "Architecture, primary modules, runtime and deployment notes, and environment variable reference.",
    sections: ["Architecture", "Primary Modules", "Runtime & Deployment", "Environment Variables", "Roadmap"],
  },
];

const quickLinks = [
  { href: "/map", label: "Open App", icon: "→", description: "Jump straight into the map editor" },
  { href: "/about", label: "About", icon: "ℹ", description: "Platform overview and feature status" },
  { href: "/terms", label: "Terms of Use", icon: "⚖", description: "Usage terms and limitations" },
  { href: "/privacy", label: "Privacy Policy", icon: "🔒", description: "How we handle your data" },
];

export default function DocsIndexPage() {
  return (
    <div style={{ minHeight: "100vh", backgroundColor: "#ffffff" }}>
      <InfoNav />

      {/* Hero */}
      <section
        style={{
          background: "linear-gradient(150deg, #1e1b4b 0%, #3730a3 50%, #4f46e5 100%)",
          padding: "72px 24px 64px",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute", inset: 0,
            backgroundImage:
              "linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)",
            backgroundSize: "40px 40px",
          }}
        />
        <div style={{ maxWidth: 720, margin: "0 auto", textAlign: "center", position: "relative", zIndex: 1 }}>
          <div
            style={{
              display: "inline-flex", alignItems: "center", gap: 8,
              padding: "5px 14px", borderRadius: 99,
              backgroundColor: "rgba(255,255,255,0.1)",
              border: "1px solid rgba(255,255,255,0.2)",
              marginBottom: 24,
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
              <path d="M4 19.5A2.5 2.5 0 016.5 17H20" stroke="rgba(255,255,255,0.8)" strokeWidth="2" strokeLinecap="round" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" stroke="rgba(255,255,255,0.8)" strokeWidth="2" />
            </svg>
            <span style={{ color: "rgba(255,255,255,0.85)", fontSize: 13, fontWeight: 500 }}>Documentation</span>
          </div>

          <h1
            style={{
              fontFamily: "Google Sans Display",
              fontSize: "clamp(32px, 4.5vw, 52px)",
              fontWeight: 700, color: "white",
              lineHeight: 1.1, letterSpacing: "-0.02em",
              marginBottom: 18,
            }}
          >
            Transit Planner Docs
          </h1>
          <p style={{ fontSize: 16.5, color: "rgba(255,255,255,0.72)", maxWidth: 500, margin: "0 auto", lineHeight: 1.7 }}>
            User guides and technical reference for Transit Planner — an AI-assisted, map-first workspace
            for sketching transit lines and producing planning-ready GTFS.
          </p>

          <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 44, opacity: 0.5 }}>
            {LINE_COLORS.map((color, i) => (
              <div key={i} style={{ height: 3, width: 36, borderRadius: 2, backgroundColor: color }} />
            ))}
          </div>
        </div>
      </section>

      {/* Doc cards */}
      <section style={{ maxWidth: 1000, margin: "0 auto", padding: "64px 24px 0" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 20 }}>
          {docCards.map((card) => (
            <Link
              key={card.href}
              href={card.href}
              style={{
                display: "block", padding: "32px 28px",
                borderRadius: 16, border: "1px solid #e7e5e4",
                backgroundColor: "#fafaf9", textDecoration: "none",
                transition: "border-color 0.15s, box-shadow 0.15s",
              }}
            >
              <div
                style={{
                  width: 46, height: 46, borderRadius: 12,
                  backgroundColor: card.bg, color: card.color,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  marginBottom: 18,
                }}
              >
                {card.icon}
              </div>
              <h2 style={{ fontFamily: "Google Sans Display", fontSize: 20, fontWeight: 700, color: "#1c1917", marginBottom: 8 }}>
                {card.title}
              </h2>
              <p style={{ fontSize: 14, color: "#78716c", lineHeight: 1.65, marginBottom: 20 }}>
                {card.description}
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {card.sections.map((s) => (
                  <span
                    key={s}
                    style={{
                      fontSize: 12, fontWeight: 500,
                      padding: "3px 10px", borderRadius: 99,
                      backgroundColor: card.bg, color: card.color,
                      border: `1px solid ${card.bg}`,
                    }}
                  >
                    {s}
                  </span>
                ))}
              </div>
              <div
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  marginTop: 22, fontSize: 13.5, fontWeight: 500, color: card.color,
                }}
              >
                Read docs
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* Quick links */}
      <section style={{ maxWidth: 1000, margin: "0 auto", padding: "56px 24px 0" }}>
        <h2 style={{ fontFamily: "Google Sans Display", fontSize: 22, fontWeight: 700, color: "#1c1917", marginBottom: 20 }}>
          Quick Links
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          {quickLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              style={{
                display: "flex", alignItems: "center", gap: 14,
                padding: "16px 18px", borderRadius: 12,
                border: "1px solid #e7e5e4",
                backgroundColor: "#fafaf9", textDecoration: "none",
              }}
            >
              <div
                style={{
                  width: 36, height: 36, borderRadius: 8,
                  backgroundColor: "#f5f5f4",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 16, flexShrink: 0,
                }}
              >
                {link.icon}
              </div>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: "#1c1917" }}>{link.label}</div>
                <div style={{ fontSize: 12.5, color: "#a8a29e", marginTop: 2 }}>{link.description}</div>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <InfoFooter />
      <DocsChatWidget />
    </div>
  );
}
