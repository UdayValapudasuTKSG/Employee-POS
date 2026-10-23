# Logos

Used in the web app (served from `/logos/`) and embedded in the emails
(`server/email.ts` reads them from `web/dist/logos`, or `web/public/logos` in
development). To change a logo, replace the file and keep the name.

| File | What | Source |
|---|---|---|
| `beharry.png` | Beharry Holdings logo, colour | beharrygroup.com header (`cropped-Group-3392-…png`) |
| `beharry-white.png` | Beharry Holdings logo, white, for dark backgrounds | beharrygroup.com footer (`Group-3391.png`) |
| `beharry-mark.png` | The Beharry "B" mark, cropped from `beharry.png`; also stands in for Edward B. Beharry & Co. | derived |
| `kfc.svg`, `kfc.png` | KFC wordmark, in use since June 2026 | Wikimedia Commons, `File:KFC 2026 (wordmark).svg` (public domain as a text logo) |
| `pizza-hut.svg`, `pizza-hut.png` | Pizza Hut logo, 2025 | Wikimedia Commons, `File:Pizza Hut 2025.svg` (public domain as a text logo) |
| `sterling.png` | Sterling Products Limited logo | sterlingguyana.com header (`spl-logo-1.png`) |
| `sterling-mark.png` | The Sterling emblem, cropped from `sterling.png` | derived |

The PNG versions of the KFC and Pizza Hut logos exist for email, where many
clients (Gmail among them) do not show SVG.

Public domain on Commons covers copyright only. Every one of these is a
trademark of its owner. The Beharry Group operates the KFC and Pizza Hut
franchises in Guyana; before release, confirm this use with Yum! Brands'
franchise brand standards and with Sterling, and swap in official artwork from
each brand team if they supply it.

Brand colours, measured from the Beharry logo: red `#ED2C25`, black `#0B0708`.
Sterling's green is `#009345`.
