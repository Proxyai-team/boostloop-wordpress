---
name: boostloop-setup
description: Set up BoostLoop in an AI environment, connect its MCP server, and establish the user's chosen BoostLoop account, target-service email accounts, phone number, and persona. Use for initial setup or changing those choices.
---

# BoostLoop setup

## Connect the user's AI environment

Use the MCP endpoint and Bearer token in the user's personal setup prompt. Configure a Streamable HTTP connection named `boostloop` in this AI environment's supported MCP configuration. Preserve existing connections. Store the token in the environment's private secret setting or an environment variable; do not copy it into the public skill, source control, or diagnostic output. This skill itself contains no credentials.

For Codex, use `[mcp_servers.boostloop]`, `url = "<MCP_URL>"`, and `bearer_token_env_var = "BOOSTLOOP_MCP_TOKEN"`. For other clients, use their documented HTTP URL and Authorization header configuration. The MCP URL must be reachable from the machine running the MCP client. A localhost URL points to that machine; if the client runs elsewhere, use BoostLoop’s deployed HTTPS URL. A remotely hosted model can still use localhost through a local MCP client. If the client only supports OAuth, explain that this server currently uses Bearer tokens.

Install `boostloop-setup` and `boostloop-operations` in this environment's supported skill directory. If it has no skills mechanism, save them as reusable private project instructions. Get their public URLs from the setup prompt. Fetch only those skill files; never send the token to a skill download URL.

Verify the connection using `get_account` and `list_campaigns`. Do not create campaigns, start tasks, submit proof, or review decisions during connection setup.

## Choose the accounts

Confirm the BoostLoop identity first. Use choices the user already supplied. Ask only for target-service accounts and device details needed for the task they want to do; phone number and persona can remain unset until relevant. Group the relevant missing questions together:

- Which BoostLoop account/email should this AI use? Compare it with the email returned by `get_account`. If different, have the user sign in as the intended member and copy that member's setup prompt. A token cannot switch account identity.
- Which existing account/email should be used for each target service or platform? Record service, chosen email, and browser profile if relevant. Allow more than one account, but choose a default explicitly rather than guessing.
- Which phone number, with country code, should be used when a task needs it? This is optional; allow the user to leave it unset. Ask before entering it into a service unless that use is already authorized. Never invent a number or reuse an unrelated person's number.
- Which persona should guide contributions? Establish display name, tone, interests, experience, and testing focus. Draft a persona for the user to approve if requested. It guides communication; it must not invent completed work, product experience, or personal facts.

Choosing an email does not grant mailbox access or create a target-service account. Use an existing authorized sign-in/browser context where available. Let the user enter passwords, one-time codes, or complete unsupported sign-in steps privately. If signup or account changes are required, first establish that the user wants those actions; configuration alone does not authorize them.

## Account access and mobile tasks

A saved email identifies the account to use; it does not sign in, grant browser or device control, or establish that an app was installed. Distinguish a configured profile, an authenticated service session, and available device tools when reporting setup readiness.

For mobile tasks, ask whether the user has the required Android or iPhone/iPad device and which store account it uses. Record an optional `devices` list in the private profile if useful, preserving existing fields. Leave unknown capabilities unset; check current access again when operating.

- Google Play supports reviews at play.google.com on desktop, but the same Google account must have previously downloaded and installed the app. Desktop login alone is insufficient. Work/school accounts and app beta participation can also prevent reviews. See [Google Play review instructions](https://support.google.com/googleplay/answer/4346705?co=GENIE.Platform%3DDesktop&hl=en).
- For iPhone/iPad app tasks, plan for device-assisted installation, use, and review unless the environment has verified suitable device access. Do not assume an App Store web page permits review submission. Apple's documented Mac review flow is through the native App Store for purchased/downloaded apps; this does not establish support for every iPhone app. See [Apple's Mac App Store review instructions](https://support.apple.com/guide/app-store/firab49b7b0f/mac).

Explain any current limitation and ask for the specific missing step: sign in privately, install and try the app using the intended store account, or provide screenshots and actual experience. The user can complete mobile steps while the AI handles campaign discovery and proof submission. A missing mobile device should not block setup or unrelated website tasks.

## Save a private profile

Save the agreed choices outside the repository at `~/.config/boostloop/profile.json`, or the environment's equivalent private user-data location. Use permissions limited to the user where available. For environments without local files, use an explicitly private persistent project setting supported by that environment, and explain where it is stored. Do not publish the profile or keep it in a public skill.

Suggested structure (replace placeholders with the user's agreed choices):

```json
{
  "mcp_url": "<MCP_URL>",
  "boostloop_email": "<CHOSEN_MEMBER_EMAIL>",
  "token_secret_reference": "BOOSTLOOP_MCP_TOKEN",
  "target_accounts": [
    {"service": "<SERVICE>", "email": "<CHOSEN_EMAIL>", "browser_profile": null, "default": true}
  ],
  "phone_number": null,
  "persona": {"display_name": "<NAME>", "tone": "<TONE>", "interests": [], "experience": [], "testing_focus": []}
}
```

Store a token reference rather than the raw token in this profile. Do not store passwords or verification codes. Leave unknown/optional values unset; do not manufacture details.

Summarize which member account, target accounts, persona, and phone-number choice will be used, without repeating the token or full phone number. Tell the user where the profile was saved and that the operation skill is ready. Do not perform contribution or campaign actions until requested.
