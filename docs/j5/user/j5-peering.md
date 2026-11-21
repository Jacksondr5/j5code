# Connecting two J5 servers

A link connects two of your J5 servers, for example a work VM and your laptop. Their agents can then message each other, and you choose what agents on each server may do on the other. Agents still address each other by id, and each sees which server the other lives on, by that server's name. You can tell your agents what each server is for, such as "the laptop has Xcode for iOS builds".

Only link servers you trust. To set a link up, change its Tools levels, or renew it, see [Linked environments](./t3-code-guides.md#linked-environments). This page covers how messages travel between two linked servers and what removing a link does.

Both servers need a version of J5 that supports links. If one doesn't, **Link** names the server to update. Update linked servers together: while one is behind, no message crosses between them, and messages already sent wait until both are up to date.

If no one app can connect to both servers, run `j5 a2a peer` on each server for messages (`j5 a2a peer --help` lists the steps), and `j5 environment link` for tools.

## How messages travel

When you link two servers, J5 checks which one can reach which and how each is run, then says how messages will travel. **Change**, on that server's line, lets you pick another way before you link.

- **Sent directly both ways.** Each server delivers to the other. This suits two servers that are always on and can reach each other. A message sent to a server that is off isn't delivered: it fails after a few quick retries.
- **One server polls.** That server opens every connection itself: it sends its messages to the other server directly, and the other server keeps messages for it until it asks for them. J5 picks this for a server that can't be reached, such as a laptop behind an office firewall, and for one that isn't always on, such as a server run by the desktop app. Nothing needs to be opened on a firewall.

While a server that polls is awake, messages reach it within seconds. While it's asleep or closed, they wait until it's next on, and each agent's messages arrive in the order it sent them. An agent sending to it is told that it is offline and when it was last available.

A server that polls also keeps a connection open to the other server while it runs. That is how the other server's agents use tools on it, so they can only while it is running.

To change how messages travel between two servers, remove the link, then link them again.

## Server names

A server's name is its computer name; on Windows, or where the machine has none, it's the hostname. To rename it, rename the machine, then restart J5 on it (quit and reopen the desktop app, or restart the server): on macOS, the computer name in System Settings; on Linux, `hostnamectl set-hostname --pretty "Work VM"`. J5 reads the name when it starts, and the new name reaches the other server the next time one of them polls the other, or the other server reads its address book. If you can't rename a machine, such as a managed work laptop, tell your agents in their instructions, for example "JM-LT-04213 is my work laptop".

## When a server's address changes

If you move a server to a new address, such as a new port or hostname, the servers linked with it keep trying the old one, and the pair's row under **Settings → Environments → Linked environments** shows the error. Open the row's menu (**⋯**) and choose **Edit address**. J5 checks where each server can reach the other, fills in the address it found, and switches only once the server answers there. Nothing waiting is cancelled, so there's no need to remove the link. A direction that has tools is linked again at the new address, which starts its 30 days again; one whose tools have run out is left for you to renew.

## Checking and removing a link

**Linked environments** lists every link among the servers this app manages, one row per pair. Each row shows how messages travel, each direction's Tools level, and anything that is wrong on either side. If it says the other server ended messaging, choose **Remove…** from the row's menu (**⋯**), then link the two again. If it names a server to update, update J5 there.

Removing a link ends both of its parts:

- **Messages.** Every message waiting on a server for the other is cancelled, every open Exchange between their agents is ended, and each agent involved is told. Each server revokes the credential the other held for messages, which was listed under **Settings → Sharing & access** as _Peer: <name>_.
- **Tools.** Each server forgets what its agents could do on the other and ends the session it held there. Work one server's agents started on the other keeps running there, but is no longer followed.

If this app can manage both servers, **Remove** does this on both. If it can't, J5 warns that the other server will keep its side, and its messages to this server's agents will fail until you remove the link there too; choose **Remove here only** only if that's what you want. Linking again starts empty.

To stop only what one server's agents may do on the other, set that direction's Tools level to **Off**. Messages are unaffected.
