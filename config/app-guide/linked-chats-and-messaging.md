# Linked chats and messages

Jenny can hand work off to a separate chat, and chats can pass short notes to each other. Both work the same way: nothing starts or sends until you choose, and nothing wakes a chat that is not already running a turn.

## Session offers

When Jenny thinks a piece of work deserves its own chat, it shows a card titled "Start this in its own session?" with a title for the task. Choices:

- Do it here: continue the work in the current chat. This is an equal choice, not a rejection.
- New session: Jenny prepares a handoff and starts a linked chat. The handoff has a Task (a self-contained request, as you would write it) and a Background (findings, constraints, decisions and file references the new chat cannot otherwise see). The full history is not copied.
- Options: choose the project, model, effort and mode for the new chat. Permissions follow the source chat and cannot be raised here. By default the new chat uses the source chat's model, effort and mode, in the same project and its already-bound workspace.
- Dismissing or ignoring the card starts nothing.

While the handoff is prepared the card shows "Preparing the new chat..." and, if something fails, a message with a retry. If the new chat exists but did not start, you can try starting it again without creating a second one. The source chat stays in view with a link and an Open action; Jenny does not switch focus or open a split on its own.

An offer pauses the decision at that point of the conversation. A pending offer survives a restart and expires after seven days. If you explicitly asked for separate work and a launch grant exists, the card is skipped; without a recorded authorization the ordinary offer appears, because a model's claim that you asked is not authorization.

## Suggested tasks

When Jenny has several unrequested follow-up ideas, it groups them in one "Suggested tasks" card (for example, "2 suggested tasks"). Each task has its own Dismiss, Options, Do it here and Start. Start opens that task in a new linked chat. Start all starts every task that is still pending and unexpired at the moment you click, one new chat each. Tasks added later are not included, tasks run through normal admission and are not promised to run at the same time, a failed row can be retried alone, and one failure does not cancel the others. Suggestions that nobody acts on expire after seven days.

## The linked tree

A chat started from another chat nests below it in the chats panel. Several children appear as siblings, oldest first. A parent shows when children are working or unread. The linked relationship is permanent and does not change if you send messages. A child exposes a link back to its parent and shows "Linked chat of" followed by the parent chat title. If the parent is archived, filtered out or in another project the child shows as its own row with an origin note; deleting or archiving a parent never deletes or stops its children.

Starting several chats does not authorize conflicting writes to a shared checkout. Chats are queued or marked Needs attention when they cannot run.

## Report back

A linked child reports each finished, failed or cancelled turn to its immediate parent. The parent sees a report card with the outcome (turn finished, failed, cancelled or waiting for a decision), a clipped preview of the answer, Open chat and Discard. A report is one card per terminal turn, not one per internal step, and it does not start any model call by itself.

You can turn reporting off per chat: in a linked child's row menu, clear Report back to the original chat.

## Send to chat

Any chat's row menu has Send to chat. It opens a picker, titled "Share a note with another chat", that searches chats in every project. Pick a recipient, edit the message, and press Send.

- Only the text you see is shared. No history, files or permissions go with it. The limit is 16 KB.
- Archived or deleted chats and legacy transcripts that cannot continue are not offered.
- A message to a chat in another project is allowed because you chose the recipient explicitly.

## Messages Jenny sends

Jenny can send a message to another chat only through the session_message tool, and only with your authorization:

- A message grant: in the send dialog you can allow messages in one direction (from this chat to that chat) for seven days. A grant needs a purpose, has a limited number of sends, shows "N sends left", and can be revoked at any time.
- Otherwise each send asks for approval, showing the exact recipient and the full text, even in Auto mode. Approval is for that one send.

Jenny's tool can list targets, read messages already included in this chat, and send. It cannot send in Plan mode or a read-only chat. A limit applies to how many messages one reply may send.

## What a received message is

A message from another chat is attributed context, not an instruction. It names its source chat and is shown as data. It never grants Jenny any permission, never authorizes a reply, and never wakes the recipient or interrupts its turn. It waits for the recipient's next turn.

## The message strip and Review

A strip near the composer shows messages for this chat: how many are waiting and will be included in the next turn, messages excluded, and delivery status for ones you sent (Sending, Sent to a chat, Delivered, Couldn't deliver with Retry or Cancel send).

Review opens "Messages from other chats". Queued messages go to the model on this chat's next turn. For each one you can leave it out (Don't include) so it is not shown to the model, queue it again, or Discard it for good. If the context is full, messages show "Waiting - context is full" and are not silently dropped.

Opening the chat marks a message read but does not send it to the model. If a restored archive contains a message that was waiting to send, it shows as Not sent with Review and send; nothing goes out until you press Send.

## Linked chats and proposals in plan or read-only chats

A Plan-mode child stays in Plan mode. Plan mode or a read-only chat can also block some offered choices, and a card says so instead of acting.
