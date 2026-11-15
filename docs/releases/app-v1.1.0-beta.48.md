# OpenAgent App 1.1.0 beta 48

- Session panel: a new Goal section shows the conversation's goal, its state
  (active, paused, achieved), how many automatic continuations it has used,
  and the agent's note, outcome or pause reason. Set or replace the goal there,
  or Pause, Resume, Mark done and Clear it. The panel refreshes when a turn
  starts or ends and when the goal changes from another client.
- Composer: `/goal <objective>` sets the goal (`/goal status | pause | resume |
  done | max <n> | clear` manage it). Picking /goal from the menu inserts it so
  you can type the objective.

Goals need OpenAgent server 1.1.9 beta54 (Core 1.1.0 beta96) or later; on an
older server the section says goals are not supported. The app keeps Host
Tools beta18, the existing application ID, local profiles and device consent.
