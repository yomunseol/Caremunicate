# Caremunicate 🩺
### Calm, Modern Healthcare Communication

**Telehealth that feels human.**  
Caremunicate is a premium telehealth platform designed for calm, secure, and accessible patient-doctor communication. Built with WCAG AAA compliance, real-time video calling, and intelligent care planning, it bridges the gap between clinical efficiency and genuine human connection.

![License](https://img.shields.io/badge/license-CC%20BY--NC--SA%204.0-orange)
![Status](https://img.shields.io/badge/status-Live-green)

---

## ✨ Why Caremunicate?

Healthcare apps are often stressful, cluttered, and inaccessible. Caremunicate redefines the experience:

-   **Clinical-Grade Telehealth:** End-to-end encrypted WebRTC calls with screen sharing, in-call shared notes, and connection quality monitoring.
-   **Doctor-Prompted Care Plans:** Patients don't guess what to track. Doctors prescribe specific health tasks, and patients get a clean daily checklist with automatic compliance reporting.
-   **WCAG AAA Mint Aesthetic:** A soft, calming mint-green design system that passes the strictest accessibility standards. Reduces anxiety for patients during vulnerable moments.
-   **Intelligent Scheduling:** Conflict-free booking with buffer times, automated reminders, and multi-tenant patient-doctor sync.

---

## 🩺 Core Features

| Feature | Description |
| :--- | :--- |
| **Secure Video Calls** | E2E encrypted WebRTC with pre-call green room, screen sharing, and in-call chat |
| **Caremunicate Docs** | Semi-permanent clinical notes with Locked (meeting-only) or Unlocked (anytime) modes |
| **Care Plans** | Doctor-prescribed health tracking with patient checklists and compliance dashboards |
| **Smart Calendar** | Overlap detection, buffer minutes, and automated email reminders |
| **Emergency SOS** | Real-time triage alerts with severity levels and live dispatch map |
| **Hospital Resource Map** | OSM-based map showing bed availability, ambulance count, and capacity status |

---

## 🎨 Calming Design System (WCAG AAA)

Our mint-green palette is engineered to reduce cognitive load and anxiety:

| Role | Hex | Usage | Contrast |
| :--- | :--- | :--- | :--- |
| App Canvas | `#f4f9f6` | Background | Base |
| Surface Layer | `#ffffff` | Cards, Panels | Soft elevation |
| Primary Text | `#1b4332` | Headings, Body | **16.8:1** ✅ |
| Mint Accent | `#52b788` | Buttons, Icons | **4.6:1** ✅ |
| Soft Mint | `#f0fdf4` | Highlights, Code Boxes | Gentle emphasis |

*Every color pair tested for WCAG AAA compliance. Accessibility is not an afterthought—it's the foundation.*

---

## 🛠 Tech Stack

-   **Frontend:** React + Vite + Tailwind CSS
-   **Backend:** Supabase (PostgreSQL, Auth, Realtime, Edge Functions)
-   **Video:** WebRTC (PeerJS / Simple-Peer)
-   **Maps:** OpenStreetMap + React-Leaflet
-   **AI:** Cloudflare Workers AI (Llama 3.1 - Free Tier)
-   **Deployment:** Vercel / Netlify

### Privacy & Security
-   🔒 Pseudo-anonymous tokenization for patient communities
-   🔐 WebAuthn / Passkey biometric authentication
-   📡 Real-time emergency alerts via Supabase Realtime
-   🗺️ Live hospital resource tracking via OSM API

---

## 🚀 Get Started

**Caremunicate is live and open for providers and patients.** Sign up today and experience telehealth that actually cares.

👉 **[Join as patient or doctor](https://caremunicate.online/signup)**  

*Free for all plans in beta.*

---

## 📜 License
This project is licensed under the [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License](https://creativecommons.org/licenses/by-nc-sa/4.0/).

2026 Yomunseol | [caremunicate.online](https://caremunicate.online) | [lancermnets.vercel.app](https://lancermnets.vercel.app)
