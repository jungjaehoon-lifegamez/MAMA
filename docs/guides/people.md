---
title: People and DMs
parent: Guides
nav_order: 13
---

# People and their DMs

Each person who uses MAMA, owners included, has its own Telegram DM with the bot. A DM has its own
session, workspace and personal records. The common group (`owner_chat_id`) holds the common
session: source changes, reports, shared work and the owner policy. Set up Telegram first with the
[Telegram guide](telegram.md).

## Owners and members

Register each owner with `mama register-owner <telegram id>` while the daemon is stopped. An owner
is a member with the `owner` role.

To add someone else, ask MAMA in your DM or in the common group to enroll a member. Telegram shows
a picker; choose the person. You can give a name at the same time, or later ("call this member
…"). Every session shows names instead of ids.

Owners manage members from their DMs or the common group:

- grant or revoke a project, which lets the member read that project's records;
- suspend, resume or offboard a member;
- suspend and resume another owner. Nobody can suspend itself, and an owner cannot be offboarded.

Ask "who are the members?" to see each member's status, grants and the latest enrollment results.

## What a DM can do

A DM works with that person's own records. What it saves stays personal unless the person shares
it. An owner's DM also reads the common records and sources, the owner policy and the owner rules,
and can search and fetch the web. It can open a Google Drive file, such as a sheet, which is saved
in that person's own downloads. Every DM can write and run scripts in its own workspace, make
PowerPoint, Word, Excel and PDF files, and work with tables and charts (numpy, pandas and
matplotlib, with Korean and Japanese labels); on macOS it can also look at each page before sending
a file (see Documents below). It cannot install other packages. Changes to common things happen in
the common group: shared
records, the owner policy and rules, reports, the wiki and files sent to the group. A DM that is
asked for one of these says so.

At the start of a session, and on its first turn after each restart, a DM is told which sources it
can read. It also learns the chat platforms each source holds, for example Kakao and LINE chats kept
inside an imported archive.

## Scheduled jobs

Ask in your DM for something to happen on a schedule, for example "every weekday at 9:00, list
what changed on the board". MAMA saves a job with a time and a time zone. Each run looks at your
records and sources at that moment and sends the result to your DM. A run with nothing to say sends
nothing. Jobs must be at least an hour apart, and a person can have up to ten active jobs. Ask to
list, change, pause or delete them at any time. A job runs with no one in the conversation. For a
person with the owner role it searches the web but opens pages only from the sites listed in
`agent.autonomous_web_fetch` (none by default). With the Claude backend, ask in your DM when you
want a page read; the Codex backend searches the web but does not open pages. Other members have no
web tools.

## Notices

When a source change concerns a member, the common session can name that member. The member's own
session then reads the change with the member's access and decides whether to send a short notice
to the member's DM. Nothing the member cannot read is sent. Like a job, a notice opens no web page
outside the listed sites.

## Skills

A skill is a way of doing a task that MAMA should repeat. Ask your DM to remember the steps as a
skill, or keep a `skills/<name>/SKILL.md` file in your workspace. Skills saved in a DM are yours.
Skills saved in the common group, and file skills an owner publishes there, are shared with the
common session and every DM; a member's session for a group has no skills.
Nobody reads another person's skills.

## Documents

Run `mama tools install` once on the host. On macOS setup runs it for you; elsewhere set
`tools_root` in `config.yaml` first. It installs a document toolkit for every session: Python
libraries for PowerPoint, Word, Excel and PDF files, LibreOffice and CJK fonts. Ask for a document
in your DM or the group. On macOS MAMA can also render a document's pages to check them before
sending it; the renderer runs only there. Sessions cannot install other packages, and their shell
has no network.

## Export and erase your records

In your own DM, ask MAMA to export your records. A ZIP of your personal records and files arrives
in the DM after the turn. Account and credential files stay out.

To erase them, ask in your DM. MAMA first shows what will be exported and deleted. Confirm in a
later message. MAMA sends the export, and erases only after Telegram confirms delivery. Your
enrollment and grants stay, and you start again in a fresh workspace. An erasure that a restart
interrupts finishes after the restart. Your messages during it wait and are answered afterwards.

## Members in the common group

A member with the `owner` role talks to the common session in the group. A member without that
role gets a session of its own for the group. That session reads only what the member's grants
allow and none of the member's personal records. It cannot read chat from before the member
enrolled. In the common group such a member may also change shared work in its granted projects and
the owner policy, and each change records who made it. In any other allowed group, members cannot read or change the
owner policy.
