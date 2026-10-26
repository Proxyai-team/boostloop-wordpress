---
name: boostloop-operations
description: Use BoostLoop MCP to choose and complete contributions, submit proof, create and publish campaigns, and review proof. Uses the account, phone-number choice, and persona established by boostloop-setup.
---

# BoostLoop operations

## Account and context

Read the private profile established by `boostloop-setup` (normally `~/.config/boostloop/profile.json`) and verify `get_account` matches its BoostLoop email. Use the profile's chosen target-service account/browser context and persona. If the profile is missing or the member identity differs, use the setup skill or ask for the missing choices before mutating anything. Do not switch accounts, use another email/phone number, or invent persona details silently.

The persona guides tone and task selection, not fictional evidence or product experience. Use a saved phone number only when relevant and authorized. Existing user authorization remains valid; do not request the same permission repeatedly.

## Check task feasibility and request help

Before starting a task that depends on an external service or mobile device, check the required account, current sign-in, device access, and ability to gather the published proof. Profile entries are choices, not evidence that access or installation exists. Use the user's existing answers and authorization; ask only for what is missing.

- **Android installs/testing:** A desktop browser alone cannot establish installation or actual use on the user's Android device. If no suitable device tools are available, ask the user to install and try the app, then send the required screenshots and observations.
- **Google Play reviews:** Desktop submission is supported for an app previously downloaded and installed with the same Google account. Check the intended account and whether Write a review is available. If missing, explain the actual blocker or uncertainty and request installation/account correction; work/school accounts or beta participation may prevent reviews. Use the user's actual app experience when drafting. See [Google's instructions](https://support.google.com/googleplay/answer/4346705?co=GENIE.Platform%3DDesktop&hl=en).
- **iPhone/iPad installs, testing, and reviews:** Default to a user-assisted device workflow unless suitable device access has been verified. Do not promise desktop-browser review submission. The native Mac App Store review flow does not establish that every iPhone app can be reviewed from Mac. Ask the user to complete unsupported steps on their device and return the required evidence. See [Apple's Mac review instructions](https://support.apple.com/guide/app-store/firab49b7b0f/mac).
- **Other services:** Check the available browser session and the campaign's requirements rather than assuming an email or persona grants access. Let the user complete passwords, verification codes, and unsupported sign-in steps privately.

Tell the user what the AI can do now, what is blocked, and the concrete action needed to continue. For example: "I can prepare the review and submit BoostLoop proof. Please install and try this app on your Android phone using the same Google account, then share your experience and the required screenshot."

Resolve feasibility before reserving a 24-hour slot, unless the user explicitly wants to reserve it while completing the missing step. If already started, report the remaining time and needed action. Pause the dependent step until access or genuine evidence is available, while continuing independent authorized work. Do not claim completion, invent proof, or silently skip requirements. In this context, reporting a blocker means informing the user; do not call `report_owner` for an account/device limitation.

## Contributions and proof

1. `list_campaigns` searches/filter campaigns with 20 entries per page. Read additional pages as needed. Task IDs: `install`, `store_review`, `site_review`, `site_upvote` (Upvote/Likes), `follow_subscribe`, `share_repost`, `video_views`, `user_testing`.
2. Read `get_campaign` before choosing/starting: instructions, proof requirements, reward, status, available slots, and owner. Do not start your own campaign or one already joined. Use `list_my_contributions` to check history.
3. When the user authorizes participation, use `start_task`. The returned contribution ID is needed for proof; the slot expires after 24 hours.
4. Perform the underlying task using the chosen account and persona only within the user's authorization. MCP records participation and proof; it does not itself perform an external install, review, like, follow, share, video view, or user test. If the environment cannot complete the work, explain what the user must do. Never claim actions or experience that did not happen.
5. Prepare genuine evidence meeting the published requirements. `upload_screenshot` accepts plain base64, filename, PNG/JPEG/WebP, maximum 5 MB each and five screenshots. `submit_proof` accepts text, a URL, or previously uploaded screenshots.
6. Submit when authorized. Submission locks proof and starts the 72-hour review period. Report the submitted status and contribution link; pending karma cannot be spent. Use `get_proof` to check current status after uncertain network results rather than repeating submission.

## Open campaigns

Use `get_wallet` to check available karma. Gather title, task type, platform, target URL, instructions, proof requirements, completion count, and reward for user testing. Resolve missing requirements before publishing.

Fixed rewards: install 10, store review 20, site review 20, Upvote/Likes 5, Follow/Subscribe 5, Share/Repost 10, Video views 5. User testing uses a whole-number reward of at least 5. Site/social types use platform `website`; install/store review use Android, iOS, Shopify, WordPress or Wix.

`create_campaign_draft` creates an editable unfunded draft. `publish_campaign` funds an existing draft. `open_campaign` creates AND publishes, reserves reward × slots, and freezes campaign terms. Use `get_campaign` to inspect an existing campaign and retrieve its browser URL; it does not create anything.

A request to prepare a campaign or draft does not authorize publication. If the user explicitly asks to open/publish with settled details, proceed within that authorization. If `open_campaign` fails after creating a draft, use the returned draft ID rather than creating another campaign. `pause_campaign`, `resume_campaign`, and `cancel_campaign` manage existing campaigns; canceling closes unsubmitted tasks while keeping submitted proofs funded.

## Review proof

Use `list_proofs_to_review` (pending by default, 20 per page), then `get_proof`. Compare evidence with the campaign's published instructions and proof requirements. Inspect images with `get_screenshot`; browser file links require a signed-in browser.

If asked to review or recommend, state whether requirements are met and identify concrete supporting evidence or missing items. Do not turn a recommendation request into an approval or denial. When the user authorizes decisions, use `approve_proof` to pay the contributor or `deny_proof` with a specific required explanation. Do not add requirements after the work was done or invent evidence.

Owner decisions are limited to their campaigns. Denial is unavailable after 72 hours; automatic approval becomes due then and settles on scheduled processing. Read current status before retrying a decision. `report_owner` is for unfair denial of the user's own contribution, requires a reason, can affect the owner's account, and does not award karma.

## Results and errors

Report resulting campaign/contribution IDs, page links, status, and karma movement. Distinguish drafts, published campaigns, started work, submitted proof and approved proof. Do not silently retry non-idempotent mutations after ambiguous failures. Inspect existing records first. Explain expired/revoked tokens, missing permissions, unavailable slots, insufficient karma, and incomplete proof plainly.
