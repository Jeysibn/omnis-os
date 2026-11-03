# Omnis OS web interface

The web app uses neutral, light content surfaces with a restrained navy application header and blue
interaction accents. This is intentional: it follows the product brief's neutral readable surfaces
and restrained navy and blue palette while keeping operational records easy to scan.

The run event stream stays connected while the Runs workspace is open, including when the inspector
is below the fold. Leaving Runs or signing out closes the stream. This avoids repeated reconnection
and replay when a user scrolls through a long history; only the selected run is subscribed to.

Browser tests use a strict Playwright API fixture and synthetic mock records. They verify frontend
request contracts and interactions, not behavior against a live backend.

The current API has no authorization lookup endpoint. If an owner decision request has an uncertain
network or response outcome, the interface does not repeat the decision or start a run; the owner
must review the authorization through the available operational process.
