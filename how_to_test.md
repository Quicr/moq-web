# Testing Top-N + SSTS/DTS Demo

## Live URLs

| Service | URL |
|---------|-----|
| Meet App | https://meet.mocha-net.dev |
| Relay | https://relay.mocha-net.dev (QUIC/WebTransport) |
| Live-View Dashboard | http://44.233.114.143:9091/ |
| DTS Budget API | http://44.233.114.143:9091/dts/budget |

---

## Quick Start

1. Open https://meet.mocha-net.dev in **Chrome** (WebTransport requires Chrome/Edge)
2. Enter a Room ID (e.g. `demo`)
3. Enter your display name
4. Check **Simulcast (3 layers)** checkbox
5. Select relay: **US West** (`relay.mocha-net.dev`)
6. Click **Join**

---

## Test Scenarios

### Scenario 1: Basic Simulcast + DTS (Equal Rank)

**Setup:**
1. Join the room as yourself
2. Click **Add Bot** 2-3 times to spawn synthetic participants
3. Ensure **Rank Mode** is set to **Equal**

**Test bandwidth degradation:**

| Bandwidth | Expected Quality |
|-----------|-----------------|
| 6000 kbps (Normal) | Each participant gets 720p (budget/N per set > 2000) |
| 4000 kbps (Moderate) | 2 participants → 720p each; 4 participants → 360p each |
| 3000 kbps (Constrained) | All get 360p |
| 1500 kbps (Severe) | All get 180p or some drop out |

**How to test:**
- Use the **Bandwidth Cap** slider in the Demo Controls panel (right side)
- Or use the preset buttons: Normal / Moderate / Constrained / Severe / Critical
- Watch the quality badge on each video tile change color:
  - **Green** = 720p
  - **Yellow** = 360p  
  - **Red** = 180p

### Scenario 2: Speaker Priority (Rank-Based Allocation)

**Setup:**
1. Same room with 2+ bots
2. Switch **Rank Mode** to **Speaker Priority**

**Expected:**
- The loudest speaker (rank=0) gets the full budget first → 720p
- Other participants (rank=1) share the remaining budget → 360p or 180p
- Under severe congestion, the speaker still gets the best available quality while others degrade

**How to observe:**
- The first bot that starts "speaking" will show a green (720p) badge
- Other bots show yellow (360p) or red (180p) badges
- The bots alternate between speaking and silent states

### Scenario 3: Live Budget Control via API

You can control the DTS budget directly without the UI:

```bash
# Set budget to 6000 kbps (normal)
curl -X POST http://44.233.114.143:9091/dts/budget \
  -H "Content-Type: application/json" \
  -d '{"budget_kbps": 6000}'

# Constrain to 3000 kbps
curl -X POST http://44.233.114.143:9091/dts/budget \
  -H "Content-Type: application/json" \
  -d '{"budget_kbps": 3000}'

# Severe constraint
curl -X POST http://44.233.114.143:9091/dts/budget \
  -H "Content-Type: application/json" \
  -d '{"budget_kbps": 1500}'
```

Response: `{"ok":true,"budget_kbps":3000,"decisions":4}`

### Scenario 4: Multi-Browser / Multi-Device

1. Open https://meet.mocha-net.dev in **two separate browser profiles** (or two devices)
2. Both join the same room with different names
3. Enable Simulcast on both
4. Speak into one → that participant's video appears on the other
5. Adjust bandwidth → observe quality changes on received video

---

## What to Look For

### Video Quality Badges
Each video tile shows a colored badge indicating the received rendition:
- **720p** (green): Full quality, high bandwidth
- **360p** (yellow): Medium quality, moderate bandwidth  
- **180p** (red): Low quality, constrained bandwidth

### Grid Layout
- **1x2**: Shows 2 participants side-by-side
- **2x2**: Shows up to 4 participants in a grid

### Bot Behavior
- Synthetic bots alternate between speaking and silent states
- When speaking: video objects carry `SPEECH_ACTIVITY=1` extension
- When starting speech: `SPEECH_ACTIVITY=2` (SPEECH_START) triggers active speaker ranking
- The relay's Top-N filter selects the loudest N speakers

---

## Relay Monitoring

### Live-View Dashboard
Open http://44.233.114.143:9091/ in a browser to see the real-time active speaker timeline with:
- Track observations (speech activity values)
- Subscriber add/remove events
- Registration events

### Relay Logs
```bash
ssh -i ~/.ssh/mocha-deploy ubuntu@44.233.114.143 "journalctl -u moq-relay -f"
```

Look for:
```
DTS allocation: budget=3000kbps, 4 decisions
TopNCoordinator: tick: subscriber ... to_add=[...] to_remove=[...]
```

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| No video at all | Check Chrome console for WebTransport errors. Verify relay is running: `systemctl is-active moq-relay` |
| Bandwidth slider has no effect | Check browser console for fetch errors to `:9091/dts/budget`. CORS may block if on different domain |
| Bots not appearing | Check that Simulcast is checked before joining. Bots must publish to the same room. |
| All quality badges stay the same | DTS only activates after `activate_switching=true` (last rendition per participant). All 3 renditions must arrive at the relay first. |
| "decisions": 0 in API response | No subscribers have registered switching sets yet. Join with simulcast first. |

---

## Architecture Diagram

```
Browser (Subscriber)                    Relay (moqtail)
─────────────────────                   ────────────────────
                                        
SUBSCRIBE_NAMESPACE                     
  [room, '720p'] + TopN(max=2)  ──────► Stores TopN filter
  [room, '360p'] + TopN(max=2)  ──────► 
  [room, '180p'] + TopN(max=2)  ──────► 
  [room, 'audio']               ──────► (no filter)

                                        Publisher sends PUBLISH for each track
                                        Relay fans out PUBLISH to subscribers

◄────── PUBLISH [room/720p/alice, video]
◄────── PUBLISH [room/360p/alice, video]  
◄────── PUBLISH [room/180p/alice, video]

PUBLISH_OK + SSTS{                      
  set_id: 1,                    ──────► DTS registers track in switching set 1
  threshold: 2000,                      
  fraction: 5,                          
  activate: false,                      
  rank: 0                               
}                                       

PUBLISH_OK + SSTS{                      
  set_id: 1,                    ──────► DTS registers, activate=true
  threshold: 500,                       → Runs allocation algorithm
  fraction: 5,                          → Sets forward=true on 720p
  activate: true,                       → Sets forward=false on 360p, 180p
  rank: 0                               
}                                       

                                ◄────── Only 720p objects forwarded!

POST /dts/budget {budget: 3000} ──────► Re-allocates all subscribers
                                        → Now 360p selected (threshold 1000 ≤ 1500/set)
                                        → forward=true moves to 360p track
                                ◄────── Now 360p objects forwarded!
```

---

## Re-deployment

If you need to redeploy after code changes:

```bash
# Quick meet-only deploy
cd /Users/snk/work/tech/moq/moq-web-tail
MOQT_VERSION=draft-16 pnpm --filter @moq-web/meet build
scp -i ~/.ssh/mocha-deploy -r apps/meet/dist/* ubuntu@100.23.225.210:/srv/moq-meet/

# Full deploy (relay + meet)
./apps/meet/scripts/deploy-ssts.sh

# Verify only
./apps/meet/scripts/deploy-ssts.sh --verify
```
