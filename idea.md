# City Maintenance Dispatch from Footage Already Being Collected

*Working concept for the Real-Time Video Agents Hack (London, 17 Oct 2026).*

---

## The one-liner

Autonomous vehicles and city fleets already film every street, every day. We turn that unwatched footage into **tomorrow's maintenance plan**: we find every issue on the street, decide how to fix each one, and route the right crew to it.

---

## The problem

Keeping a city's streets in working order means finding and fixing a long tail of small problems:

- cracked and deteriorating pavement
- graffiti and tagging
- faded crosswalks and lane markings
- abandoned or unsafe construction zones
- damaged or obstructed signs
- overflowing bins and dumped items

Today, cities find these problems in two ways, and both are poor:

1. **Manual inspection.** Staff drive or walk routes and log issues by hand. It's slow, expensive and infrequent, so most streets go a long time between inspections.
2. **Citizen complaints (311 reports).** Reactive and patchy. Issues get reported where people complain most, not where the need is greatest, and reports often lack the detail needed to send the right crew with the right equipment.

Even once a city knows about an issue, it still has to decide **which crew goes where, in what order, with what equipment**. Planners usually make that call by hand, separately for each department (roads, sanitation, graffiti removal, signage).

## Why it matters

- **Safety:** faded crossings, unsafe work zones and obstructed signs put pedestrians, cyclists and drivers at risk.
- **Cost:** small defects left unrepaired grow into expensive repairs; cracked pavement eventually needs reconstruction instead of a patch.
- **Liability:** cities face claims for injuries and damage caused by street conditions they "should have known about".
- **Wasted crew time:** crews driving inefficient routes, or arriving with the wrong equipment, spend less of the day actually fixing things.
- **Fairness:** complaint-driven maintenance under-serves areas where people report less.



## The overlooked opportunity

**The footage already exists.** Autonomous vehicles, delivery fleets, buses, garbage trucks and ride-hail vehicles with dashcams cover a city's streets every day. That video is recorded for driving purposes and then sits in storage, unwatched.

No new sensors, inspection vehicles or staff are needed: the city's streets are already being filmed. What's missing is a system that **watches that footage, understands what needs fixing, and turns it into an action plan**.

---



## Our solution

An AI agent that turns fleet footage into an optimized city maintenance plan, in three steps:

### 1. See: find every issue in the footage

We search hours of street footage for anything a city would send a crew to fix. Each finding is verified, classified (pavement, graffiti, markings, work zone, signage, waste) and graded for severity, with the clip as evidence and its GPS location on a map.

### 2. Decide: work out how to fix each issue

For every verified issue, the agent recommends the repair: what needs doing, which type of crew should do it, roughly how long it will take, what equipment is needed, and how urgent it is.

### 3. Act: route the crews

Given the day's jobs, the available crews (each able to handle only certain job types), their shift hours and their vehicle capacity, we compute the best route for every crew so the most important work gets done with the least wasted time. When something urgent comes up, the plan updates instantly.

**The output:** a map of every issue across the city, and tomorrow's route for every crew, each job linked to the video clip that shows it.

---



## How we plan to build it (high level)

The whole pipeline runs on NVIDIA's stack, with each model doing a distinct job:


| Step             | Technology                              | Role                                                                                                |
| ---------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Find             | **NVIDIA Cosmos-Embed1**                | Semantic search across all footage to surface candidate issues quickly                              |
| Verify and grade | **NVIDIA Cosmos Reason**                | Physical-world reasoning on each candidate clip: confirm the issue, classify it, grade its severity |
| Plan the fix     | **NVIDIA Nemotron** (via W&B inference) | Turn each verified issue into a work order: repair type, crew type, time estimate, urgency          |
| Route the crews  | **NVIDIA cuOpt**                        | GPU-accelerated optimization of crew routes across job types, shifts and capacities                 |
| Infrastructure   | VAST AI OS, CoreWeave                   | Video ingestion, storage and indexing (provided by the event)                                       |


**Data for the demo:** the event's pre-indexed footage, including Toronto forward-facing dashcam drives (the PIE dataset). These are a stand-in for the footage an AV or fleet records every day. The original dataset's per-frame GPS lets us place each issue on a real map.

---



## Why this wins

- **Uses footage that already exists.** It matches the brief exactly: valuable video that sits unwatched in storage.
- **Goes from video to action.** Most video tools stop at "here's what we found". We go all the way to "here's who fixes it, and when".
- **Meaningful use of NVIDIA technology.** Four NVIDIA components, each essential, chained from raw video to decisions: Cosmos sees, Nemotron plans, cuOpt decides.
- **Proven market.** Road and asset inspection from vehicle video is already attracting acquisitions (Michelin acquired RoadBotics; Bentley acquired Blyncsy). We go further by combining every street-maintenance category and adding optimized dispatch.
- **Natural expansion.** The same engine extends to highways, rail, utilities and private estates, and runs at the edge (e.g. on NVIDIA DGX Spark or Jetson) as fleets scale.



## How we differ from previous work

At the NYC event, *StreetCast* turned street video into cited 311 reports and *StreetAudit* flagged road markings needing repainting. Both stopped at **reporting**. We cover every maintenance category and finish with an **optimized, executable crew plan**.

---



## Open questions to settle on build day

- Confirm the Toronto dashcam footage is in our team's index, and check its quality.
- Test how reliably Cosmos Reason classifies and grades issues on short clips (first task of the day).
- Confirm with the organizers that using the dataset's GPS metadata is fine.
- Confirm hosted cuOpt access and request format.

