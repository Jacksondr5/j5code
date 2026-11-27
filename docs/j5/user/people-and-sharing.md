# People and sharing

Several people can use one server. Sharing is done from the web and desktop apps; the mobile app
does not share, leave or rename. People come in with a link, or by
[signing in](#signing-in-through-j5-connect). Each person has a name, a level at the server, a project or a
thread, and the devices paired as them.

- **Viewer** reads what they were given and changes nothing.
- **Collaborator** writes to its agents, answers their prompts, steers and stops them, and uses
  terminals, files and git there. They do not configure the server, share it, or archive or delete
  threads.
- **Owner**, for the whole server only, also configures and shares it. A server can have several.

Anyone who can write to an agent can have it do anything it can do on the server's machine. Share
writing only with people you trust.

## Sharing

An Owner shares a thread from its menu, its header or its details panel, and a project or the whole
server from **Settings → People → Share…**. The Share dialog lists who already reaches the thing.
Change or remove a level there; a level held through a wider scope is changed at that scope.

To bring someone in, make a link. **Add a person** makes a link for one person and one device, at
any level, under the name you type for them. Typing the name of someone already on the server
gives them the level directly, with no link; if they already reach the thing at that level, the
link pairs one more device as them. **Anyone with the link** makes a link many people can open, as
Viewers. A link lasts an hour, a day, seven days or thirty days. Copy a link again, or revoke it, from the dialog or from People
until it expires or is used. Revoking it stops new people joining and removes no one.

The link opens on the server itself, by an address the server is already reachable at. Whoever
opens it confirms or types their name.

To add your own phone or laptop, type your own name under **Add a person** and open the link on that
device.

## Pairing a device from the terminal

On the server's machine, `j5 pair` makes a link for a named person:

```bash
j5 pair --person "<name>"
```

A name already on the server makes a link that pairs one more device as that person, at their
level. A name nobody has adds that person, and then needs `--level viewer`, `collaborator` or
`owner`; add `--project <id>` or `--thread <id>` to give them a project or a thread rather than the
whole server. Owner is for the whole server only. The command says which it did. Add `--tailscale`
to pair through your tailnet, as for any pairing link.

`--scope` narrows what the device may do, within the person's level. Without it, the device holds
what the person's level allows.

`j5 auth pairing create` without `--person` makes a link for a device the server does not know yet.
Whoever opens it is asked who they are before they can use anything.

## People

**Settings → People** lists everyone on a server you own, with their levels and devices, and the
links in force. Use the picker to choose among your servers. Revoke a device paired with the wrong
link, then pair it again with the right one.

To give someone who reaches a thread or a project more of the server, open the **…** menu on their
row and make them their highest level on another project or the whole server. What they held
before stays; remove it from their row if you no longer need it.

On a server you do not own, People shows only you. Rename yourself there, or with **Change your
name** in the command palette, and leave a project or the server you hold. Leave a thread from its
menu.

## Signing in through J5 Connect

A server can trust one J5 Connect, which signs people in through your company's identity provider,
or through GitHub or Google. People then sign in instead of being sent a link. Links keep working,
for people outside your company and for anyone who can't sign in.

Whoever runs that J5 Connect can sign in as anyone on your server, so trust only one you or your
company runs. To join one, an Owner opens **Settings → People → Sign-in**. It lists the redirect
URIs to give whoever runs J5 Connect, including the address you opened J5 Code at when that server
serves the page. Once they've registered the server, enter the J5 Connect's address and the client
id and secret they give you, and choose **Join**. Joining checks the secret and every redirect URI
first, and changes nothing if one is missing. When the server gains an address, join again. The
[J5 Connect runbook](../runbooks/j5-connect.md) says how to run one, and how to join from the
server's machine with `j5 auth connect join`.

To sign in:

- **In a browser**, open the server and choose **Sign in with** your J5 Connect.
- **In the desktop app**, open **Add environment**, type the server's address, and choose **Sign in
  instead**. Your browser opens to sign in, and the server is added when you come back. If you have
  to wait for an Owner, sign in again from the same page once they let you in, and it brings you
  back to the app.

Signing in never adds anyone to a server. Someone the server doesn't know yet sees **Waiting for an
Owner**, and their request shows in each Owner's Inbox and under **Settings → People**. There, an
Owner lets them in at a project or the whole server and a level, says they are someone already on
the server, or declines. They sign in again to start. A request that is declined, or left for a
week, says **Not let in** for another week.

A name or email shown with a request comes from J5 Connect and isn't proof of who someone is.
Check with the person before you let them in.

### When someone leaves

The server checks each signed-in account with J5 Connect every hour. Someone whose company account
is disabled loses access within a day while J5 Connect is reachable, and within 48 hours at
worst while the server is running. That includes a phone or browser they paired from a device they signed in on.

Removing someone under **Settings → People** cuts them off at once. GitHub and Google accounts
outlive a job, so with those, remove the person when they leave.

**Unbind** on an account under **Sign-in** signs out the devices that signed in with it, and keeps
the person. **Leave** signs out every device that signed in, and drops the requests. People stay
on the server with what they reach.

## When a device is asked your name

A server asks what people and agents on it should call you before a device it cannot place
uses it, and before the first owner's first device does. Pick yourself from the list, or name
someone new. On the mobile app you can also choose **Remove this server** to forget it on that
phone, and a phone the server does not know can choose **Not now**, which asks again the next time
the app opens; until then that server shows nothing.

## What changes for people who are not Owners

Settings shows only General, Appearance, SnapShots, Open-source licenses and People to someone who
owns no connected server. On the mobile app it shows the pages about the phone itself: its look,
language and input, its servers, notifications and About. A Collaborator also sees **Voice**, to
turn on voice input for their own device; only an Owner can change its key or models. A New thread,
a fork or a new project is offered only where the person may start one.

When a person's level changes, each of their devices reconnects once with the new level, the
mobile app and web or desktop where that server was added as another environment included. A device
that was offline longer than its session lasts is paired again with a new link. Someone who has
lost everything they were given sees "Nothing is shared with you" until an Owner shares something
again.
