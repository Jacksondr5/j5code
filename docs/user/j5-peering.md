# Connecting two J5 servers

Peering lets agents on two J5 servers message each other, for example a work VM and your laptop. Agents still address each other by id, and each sees which server the other lives on, by that server's name. You can tell your agents what each server is for, such as "the laptop has Xcode for iOS builds".

## Peer two servers

1. Connect this app to both servers. Add the second one under **Settings → Connections** with **Add environment** if it isn't there yet.
2. In **Settings → Connections → Peer servers**, choose **Add peer** and pick the other server.
3. J5 checks which way each server can reach the other and proposes a setup. It says, in plain lines, how messages will travel in each direction, and asks only what it couldn't work out. Confirm it, or choose **Set up differently** to pick the direction and addresses yourself.

Both servers need a version of J5 that supports peering. If one doesn't, the dialog names the server to update.

On a server with no browser, `j5 a2a peer` does the same steps from the command line. Run `j5 a2a peer --help` to see them.

## A laptop behind an office firewall

When one server can't be reached, for example a laptop behind a firewall that blocks incoming connections, the laptop **polls**. It opens every connection itself: it sends its messages to the other server directly, and the other server stores messages for the laptop until the laptop asks for them. Nothing needs to be opened on the firewall.

While the laptop is awake, stored messages reach it within seconds. While it's asleep or closed, they wait, and they arrive in order when it's next on. An agent sending to it is told that the laptop is offline and when it was last available.

## A server that isn't always on

If both servers can reach each other but one runs in the desktop app, or was started by hand, J5 asks how messages should get to it:

- **Send them directly** suits a server that is always on with the app open. Messages sent while it's off are lost.
- **Store them until it polls** is the default and is safe if you're not sure: messages wait until it's next on.

## Server names

A server's name is its computer name. To rename it, rename the machine, then restart J5 on it (quit and reopen the desktop app, or restart the server): on macOS, the computer name in System Settings; on Linux, `hostnamectl set-hostname --pretty "Work VM"`. J5 reads the name when it starts, and the new name reaches the other server the next time they talk. If you can't rename a machine, such as a managed work laptop, tell your agents in their instructions, for example "JM-LT-04213 is my work laptop".

## Checking and removing a peer

Each row under **Peer servers** shows how messages travel and any error. For a pair that polls, it also shows whether the other server is online and what is waiting for it; for a pair that sends directly, whether the other server still holds its credential here. If a server that polls stops because the other server rejected its credential, choose **Peer again** on its row. If the two servers run incompatible versions, the row says which one to update.

Removing a peer cancels every message still waiting for it and ends every open Exchange with its agents, and each agent involved is told. Peering again starts empty. To change how messages travel between two servers, remove the peer on both servers, then peer them again.
