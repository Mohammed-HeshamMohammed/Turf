# Tasks

Work waiting to be done, grouped by area. **Nothing here is assigned yet.** Magdy assigns tasks from these lists; the person who
takes one writes their name in **Taken by**, and the task moves through the statuses below.

| Area | List | Usually for |
| --- | --- | --- |
| Company and business | [business.md](business.md) | Malaa, JooJoo, Geeha, Magdy |
| Legal and compliance | [legal.md](legal.md) | Rana, with the lawyer |
| CRM backend (Go) | [crm-backend.md](crm-backend.md) | Mohammed, Reem as she learns Go |
| Calls and texts | [calls-and-texts.md](calls-and-texts.md) | Islam |
| Web screens | [web-frontend.md](web-frontend.md) | Reem |
| Data and imports | [data.md](data.md) | Omar |
| Infrastructure | [infrastructure.md](infrastructure.md) | Eslam |
| Security | [security.md](security.md) | Joe |
| Testing | [testing.md](testing.md) | Hussein |
| AI and connections | [ai-and-connections.md](ai-and-connections.md) | Mohammed, Reem |
| Mobile and desktop (parked) | [mobile-and-desktop.md](mobile-and-desktop.md) | Geeha later |

## How a task is written

| Column | Meaning |
| --- | --- |
| **ID** | Area letters and a number (`CRM-03`). Never reused, even when a task is dropped |
| **Task** | What is done when it is finished, in one or two sentences |
| **Needs** | Other task IDs, or a decision, that must come first |
| **Source** | The plan, step or decision it comes from |
| **Taken by** | Empty until someone takes it |
| **Status** | `open` → `taken` → `in review` → `done` (or `dropped`, with the reason) |

A finished task stays in its list with status `done` and the date, so the record of who did what is kept. When a list gets long,
done tasks can move to a `done.md` beside it.

## Where tasks come from

Most of the engineering tasks are what the [people, teams, chats and clients plan](../../plans/people-teams-chats-clients/README.md)
lists as **Left** for each step: the server side of most steps is built, and their screens and outside setup are not. The rest
come from the other [open plans](../../plans/README.md) and from what the company needs before the first customer.
