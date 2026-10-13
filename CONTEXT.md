# TFI GTFS

Public transport schedules and live departure times for Irish public transport (Dublin first), served to the owner's own apps.

## Language

### Schedule

**Schedule**:
The published timetable for every Agency we carry, as one consistent snapshot.
_Avoid_: Static data, timetable, GTFS (the format, not the thing)

**Feed Version**:
One published edition of the Schedule, identified by the publisher's version string.
_Avoid_: Release, dump

**Schedule Import**:
One run that replaces the active Schedule with a newer Feed Version, all at once or not at all.
_Avoid_: Sync (when the atomic replace is what matters), refresh

**Agency**:
A transport operator that publishes routes in the Schedule, e.g. Dublin Bus, Luas, Irish Rail.
_Avoid_: Operator, company, provider

**Stop**:
A place where passengers board or alight, identified by the Schedule. A Station is a Stop that groups other Stops (platforms).
_Avoid_: Station (unless it is a parent Stop), halt

**Watched Stop**:
A Stop the owner has chosen to carry Departures for. When Watched Stops are configured, the Schedule Import keeps only them and the Trips that serve them.
_Avoid_: Favourite, saved stop, stop filter (for the Stops themselves)

**Route**:
A named, rider-facing service such as "46A" or "DART", belonging to one Agency.
_Avoid_: Line, service

**Trip**:
One vehicle journey along a Route, visiting Stops in order at set times, on the days of its Service Calendar.
_Avoid_: Journey, run

**Stop Time**:
The scheduled arrival and departure of one Trip at one Stop.
_Avoid_: Timing, schedule entry

**Service Calendar**:
The set of dates a Trip operates, from regular weekdays plus added or removed dates.
_Avoid_: Service (overloaded), calendar

**Service Day**:
The operating day a Trip belongs to. A Trip's Stop Times can run past midnight yet still belong to the previous Service Day.
_Avoid_: Date (when the Service Day is meant)

### Realtime

**Realtime Feed**:
The live stream of Trip Updates published by the NTA for Trips in the Schedule.
_Avoid_: GTFS-R (in prose), live data

**Trip Update**:
The latest live prediction for one Trip: a Delay or predicted times at its upcoming Stops, or a cancellation.
_Avoid_: Realtime update, prediction

**Delay**:
How far a Trip is running behind (positive) or ahead of (negative) its Stop Times, in seconds.
_Avoid_: Lateness

### Departures

**Departure**:
A Trip leaving a given Stop: its Scheduled Departure time, plus a Predicted Departure time when a Trip Update covers it.
_Avoid_: Arrival (unless arrival is meant), bus, result

**Scheduled Departure**:
The departure time from the Schedule's Stop Time, on its Service Day.
_Avoid_: Timetabled time, planned time

**Predicted Departure**:
The departure time after applying the latest Trip Update. Absent when no Trip Update covers the Departure.
_Avoid_: Live time, realtime time, ETA

**Walk Time**:
How long it takes the owner to reach a Watched Stop from home. A Departure leaving sooner than that can't be caught, so it isn't shown; the ones shown keep their real departure times.
_Avoid_: Offset, lead time, buffer

### Departure Board

**Departure Board**:
A physical display in the owner's home showing upcoming Departures at some of the Watched Stops, a few rows at a time. It asks for the Departures it wants; nothing about a Departure Board is stored.
_Avoid_: Display (the screen hardware), tracker, sign
