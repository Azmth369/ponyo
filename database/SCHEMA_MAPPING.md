# Ponyo database mapping

Ponyo uses the spreadsheets in this folder as the logical database design. Supabase table names are the lowercase snake_case equivalents of those sheets.

| Spreadsheet | Supabase table |
|---|---|
| CLAN_INFO.xlsx | `clan_info` |
| CLAN_INFO_SNAP.xlsx | `clan_info_snap` |
| CW_SESSION.xlsx | `cw_session` |
| CW_SESSION_PARTICIPANTS.xlsx | `cw_session_participants` |
| CW_Attacklog.xlsx | `cw_attacklog` |
| CWL_SEASONS.xlsx | `cwl_seasons` |
| CWL_SEASON_PARTICIPANTS.xlsx | `cwl_season_participants` |
| CWL_DAYWISE_ATTACKlog.xlsx | `cwl_daywise_attacklog` |
| CWL_ATTACKlog.xlsx | `cwl_attacklog` |
| CAPITAL_RAID_SEASON.xlsx | `capital_raid_season` |
| CAPITAL RAID PARTICIPANTS.xlsx | `capital_raid_participants` |
| CAPITAL_RAID_ATTACKlog.xlsx | `capital_raid_attacklog` |
| AI_CHAT.xlsx | `ai_chat` |

## Attack allowance

Normal Clan War participant rows use:

- `ATTACKS_USED` = attacks the player has actually used.
- `ATTACKS_AVAILABLE` = total attacks allowed for that war, normally `2`.
- Remaining attacks are calculated as `ATTACKS_AVAILABLE - ATTACKS_USED`.

CWL participant rows use the same two fields, with `ATTACKS_AVAILABLE` normally `1` per league day.

Capital Raid keeps its existing `TOTAL ATTACKS` field because Capital Raid attack allowance is modeled differently.

## Data flow

`CoC API -> sync service -> dedicated Ponyo Supabase -> deterministic query engine -> Sarvam/Gemini -> Discord`

The CoC API remains the source of truth. The AI does not invent or calculate the underlying clan-specific filter when the deterministic query engine has already resolved it.
