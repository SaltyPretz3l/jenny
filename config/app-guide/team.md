# Teams

A team is a small group of people, at most eight, who share projects, conversations with Jenny, a chat channel and files. One member's computer is the host: it stores everything the team shares and the others connect to it. Nothing is public, and there is no cloud service in between. This page explains how to host or join a team, what the roles allow, where people talk, how Jenny answers in a team, how files and approvals work, and who can read what.

## Where it is

The Team tab is in the top rail. With no team yet it offers "Host a team" and "Join a team". Once you are in a team it shows Channels, Projects, "Needs you", People, "Recent activity", Seats, "Team GPUs" and "Server and sharing". Settings also has a Team section, and the command palette has a Team group with "Search messages" and "New message".

## Hosting and joining

- To host: on the Team tab choose "Host a team", type a team name and press "Start the team". Your computer becomes the host. The team works while the host is running and reachable.
- To invite: the owner uses "Invite someone", picks a role (Member or Read-only) and how long the invite lasts (1 hour, 1 day or 7 days; 1 day unless changed), then "Create invite". An invite works once. The code is shown once, so copy it then.
- To join: choose "Join a team", paste the invite code and press Join. You are then waiting until the owner admits you. The owner sees "Wants to join" with "Admit", "Decline" and "Later", and should check the name and the key with the person before admitting them.
- A member can use up to three devices. A team can have eight outstanding invites.
- "Restore a team from a file" on the same page brings back a team from an export.

## Roles

Team roles:

- Owner: the person who hosts. Only the owner creates invites, admits or declines people, changes roles and removes members.
- Member: can post, edit, react and pin in channels, create projects, and share a GPU.
- Read-only: can read channels and download project files. A read-only member cannot post, react, pin or share a GPU, and is a Reader in every project.

Each project has its own roles:

- Admin: manages the project's members, its "Always allowed" rules and its audit log.
- Writer: can start turns with Jenny, upload files and answer approvals.
- Reader: can read.

The owner is not automatically inside every project; the project page offers the owner a button to join it as an admin.

## Where people talk

- #team: the team channel. Everyone on the team can read it, and members can post. Jenny does not read or answer in #team.
- Direct messages: "New message" starts one with up to seven other people. Only the participants see it, but the team's host can read direct messages, and the app says so. Jenny does not read or answer direct messages.
- Project conversations: "New conversation" on a project's page. This is where Jenny answers. Every member of the project can read a project conversation and writers can take part in it.

A message can be up to 16,000 characters with up to 8 attachments of 4 MB each. A channel keeps at most 50,000 messages or 365 days. When the team's chat storage is full the oldest messages are removed, direct messages included.

## Jenny in a team

Jenny answers in project conversations only. She runs on a local model on a GPU that a member shares; the team uses no cloud model and holds no API keys. If nobody is sharing a GPU, the conversation says that Jenny cannot answer there yet.

In a team conversation Jenny can:

- Talk with everyone in the conversation and ask structured questions.
- Read, list and search the project's team files, and write or edit them after an approval, when the project has files and the host can give her confined access to them.
- Propose changes to a project board. A member with write access accepts a proposal before anything changes.
- Answer questions about Jenny from this guide.

Jenny cannot, on any team: run commands, use a terminal, use Git, run Python, browse the web, or use plugins or MCP servers. There is no workspace folder to choose and no setting that adds these. She cannot see #team, direct messages or other conversations. Mentions in a project conversation are not sent to Jenny. For work that needs commands or a terminal, use a chat in your own Jenny on your own computer.

A failed turn is not run again by itself; send the message again.

## Sharing a GPU

A member or the owner can share their PC's GPU with the team from "This PC's GPU" on the Team tab ("Shared with the team" or "Not shared"); "Team GPUs" lists what is shared. A sharing PC keeps one outgoing connection to the host and runs whole turns on its own local model. It keeps no history.

The host and the member whose PC answers can both read the conversation a turn carries. The app says this in each project conversation.

A member's own Jenny can also use the team as an engine for their private chats. The host does not store those prompts or replies; it records only who, when and how much.

Members can send a model file to each other through the host. It passes through the host's computer, which could read it on the way and keeps none of it.

## Project files

A project admin or writer adds files with "Copy a folder from this PC into the project". The copies live on the host and belong to the team. Limits: 2 GB and 10,000 files per project, 8 GB across all projects, 64 MB per file and 512 MB per upload. Folders such as .git, .github, .vscode, .env and .jenny are not copied.

On a host that cannot yet give Jenny confined access to files, the project page says so and Jenny gets no file tools there.

## Approvals and "Always allowed"

When Jenny wants to write or edit a file, the conversation shows an approval card. Any member with write access on the project who is viewing the conversation can answer it. The first valid answer wins, and both the person who asked Jenny and the person who approved are recorded in the project's audit log.

A project admin can choose "Always allow" on the card, which saves a rule for that tool in the project, for everyone's turns. Other writers see "Allow once, ask for always", which asks an admin. Rules are listed on the project's "Always allowed" page, where an admin can add, allow, decline or remove them. A project can have 32 rules. Rules cover writing and editing files only, never folders that start with a dot, and never a plan or read-only turn. When there is any doubt, a person is asked.

## Boards in a team project

A team project's boards are shared with the project's members and kept on the host, with a history of changes. The host can read them. Jenny only proposes changes; a member with write access accepts them, and both names are recorded.

## Who can read what

- #team: every member, and the host.
- A project's conversations, files and boards: that project's members, and the host.
- A direct message: its participants, and the host.
- A turn Jenny answers: also the member whose PC ran the model.
- Your private chats in your own Jenny are not on the team server at all.

The host is a person's computer, and that person can read what is stored on it. A team is for people who trust each other; it does not separate members from each other beyond the roles above.

## Export, restore and delete

In Settings, Team, the owner can "Export this team": one file, encrypted with a password the owner chooses, holding the team's key and its stored data. Keep the password; without it the file cannot be restored. "Delete team and files" asks for the team's name and removes the team for good; nothing goes to a trash, so export first. A deleted project, by contrast, stays in a trash for 7 days.

Anyone can save messages with "Export messages", "Export this conversation" or "Export every conversation".

## Without a team

Jenny is personal by default and behaves the same when you are in no team.
