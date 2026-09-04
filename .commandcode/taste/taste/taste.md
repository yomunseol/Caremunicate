# Taste
- Uses Supabase Auth as the app's authentication backend (not Firebase), with Email OTP as the sign-in mechanism. Confidence: 0.9
- Prefers passwordless email OTP sign-in (6-digit code sent to email, then verified) over password-based login for end users. Confidence: 0.8
- Expects auth sessions to persist across page refreshes (relies on Supabase's built-in localStorage session persistence rather than manual session juggling). Confidence: 0.7
- Asks whether a feature was verified end-to-end against the real environment (live Supabase project / deployed site), not just that it compiles or builds. Confidence: 0.6
- Wants explicit loading states during async operations in forms (e.g., "Sending code...", "Verifying...") rather than silent waits. Confidence: 0.7
- Prefers multi-stage form flows (collect email -> confirm code) with the ability to go back and change input, over single monolithic submit handlers. Confidence: 0.6
