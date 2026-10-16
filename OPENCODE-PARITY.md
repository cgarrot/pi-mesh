# OPENCODE-PARITY — audit pi-mesh ⇄ OpenCode et plan

> Audit daté du 16/10/2026, après la mise en place de l'adaptateur
> (`server.ts` → `src/extension-opencode/`, `tui.tsx`) et le debug du
> broker/alias/beacon. Référence = l'extension Pi complète (la seule vraie
> spécificité de pi-mesh) ; le design d'origine de la migration vit dans
> l'historique git (`OPencode-PLAN.md`, supprimé — supersédé par ce
> document).
>
> **Mise à jour (soirée du 16/10)** — la Phase 1 est implémentée :
> livraison des entrants complète (le listener `client.on("inbound")`
> manquait : rien n'était livré !), receipts/ledger/transcript, reply
> hints, policy + deferred inbox, force→`session.interrupt`, enforcement
> des réservations (**vérifié par test réel** : un `edit` sur un fichier
> réservé par `res-test` a été bloqué avec le message attendu), activité
> réelle via les événements de session, sous-commandes `/mesh`
> ping/stale/broker/log/inbox. Plus : commandes **silencieuses** (toasts
> via `.mesh/mesh-notify-*.jsonl`, plus aucun message dans le chat),
> `session.deleted` → déconnexion propre, et **auto-détachement des
> sessions inactives** (15 min → le socket se ferme, la mailbox du broker
> garde les messages). Reste Phase 2 (watchdog M1, erreurs provider,
> `/mesh reset`) — statuts ci-dessous mis à jour au fil.
>
> **Mise à jour (fix-audit du 16/10 au soir)** — correctifs de parité +
> robustesse, tous couverts par **23 nouveaux tests automatisés**
> (`test/opencode-adapter.test.ts`, `test/opencode-runtime.test.ts`,
> suite complète 493/493 + smoke OK) :
> 1. **Race du premier appel tool** : `ensureRuntime` await le connect
>    initial (mémoïsé dans le client) — plus de `broker_unavailable`
>    fantôme sur le 1ᵉʳ appel d'une session fraîche (observé en réel).
> 2. **Parité ledger/transcript outbound** : `mesh_send`/`mesh_reply`
>    écrivent maintenant `sent`/`delivered`/`queued_offline`/`reply`/
>    `expired`/`blocked`/`error` dans le ledger (avant : entrants
>    seulement) + `transcript.record("out", …)` opt-in — même
>    ordre d'ancrage causal que le côté Pi.
> 3. **Gardes M1/M2 comme Pi** : `checkSendTarget` (bloque `to:"*"` et
>    pseudo-cibles broadcast localement, ledgeré) + `busyTargetWarning`
>    (5 min, remplace l'heuristique 60 s maison) + warning re-reply
>    (`guards.checkReply`) sur `mesh_reply`.
> 4. **`/mesh status` rooms figées** : `alias`/`rooms` du runtime sont
>    des getters vivants (le rendu reflétait la snapshot prise à la
>    création, pas les join/leave/rename).
> 5. **Fuite fd du broker** : un client qui `close()` (FIN gracieux)
>    laissait le socket accepté à moitié ouvert pour toujours (le broker
>    ne répondait pas au FIN). Fix : `socket.on("end")` → FIN retour.
> 6. **Résurrection post-close du client** : `close()` pendant un
>    connect en vol laissait le handshake se terminer → client de nouveau
>    en ligne avec un socket qui ne se fermait jamais. Fix : garde
>    `userClosed` dans `doConnect`.
> 7. **Hygiène runtime** : les 2 brokers orphelins (.hermes) ont été
>    tués ; le broker actif (supervisé par `scripts/broker-watchdog.mjs`)
>    continue de servir. Les ~49 peers idle dans `default` sont des
>    sessions zombie DANS le process OpenCode — seul un redémarrage
>    d'OpenCode les purge (Phase 0, toujours pas fait).
>
> **Mise à jour (packaging « partout »)** — le package publié fonctionne
> maintenant sur n'importe quel hôte OpenCode (vérifié par installation
> du tarball dans un projet vierge, Node strict, zéro dépendance) :
> 8. **Entrées compilées** : `dist/server.js` + `dist/index.js` (tsconfig
>    inclut les entrées racine) — `server.ts` nu ne charge PAS depuis
>    `node_modules` en Node (type stripping interdit dedans ; OK en
>    local hors node_modules, et OK sous Bun).
> 9. **`exports` map** : `"./server"` → `dist/server.js`, `"./*"` en
>    passthrough (deep imports + `tui.tsx` par nom de package), `main`
>    → `dist/index.js`. Stubs racine `server.js`/`index.js` pour les
>    hôtes qui sondent le fichier littéral.
> 10. **zod sort des dépendances runtime** : le chemin V1 l'importe en
>     lazy (`await import("zod")` dans `applyMeshToolsV1`) — le contrat
>     « zéro dépendance runtime » du package tient, V2 n'en a pas
>     besoin, et un hôte V1 sans zod dégrade en observation-only au
>     lieu de crasher. **Bloqueur de publication trouvé par le test
>     d'installation** (le checkout local masquait zod via node_modules).
> 11. **Skill `mesh-coordination`** exposé à OpenCode (symlink
>     `~/.config/opencode/skills/` — confirmé chargé en live).
>
> **Mise à jour (alignement identité/ présence)** — deux divergences Pi
> corrigées après retour utilisateur réel :
> 12. **Idle-detach supprimé par défaut** : les sessions OpenCode
>     restaient 15 min puis se détachaient (« l'agent part offline /
>     quitte la room »). Pi garde la session connectée toute sa vie —
>     c'est maintenant le défaut (0 = jamais ;
>     `MESH_OPENCODE_IDLE_DETACH_MS > 0` pour l'opt-in). Tests inclus.
> 13. **`preferredAlias` (auto-réparation)** : l'alias choisi survit aux
>     conflits — fallback temporaire persisté mais `preferredAlias`
>     conservé, retenté à chaque attach ; toast `alias_fallback` (parité
>     Pi) ; hint « qui tient l'alias, depuis quand » sur les échecs.
>
> **Mise à jour (sidebar « no session attached »)** — cause racine : le
> serveur OpenCode (daemon, cwd = $HOME) écrit beacon/identity dans
> `~/.mesh`, mais le TUI lancé depuis un dossier projet lit
> `<projet>/.mesh` (vide). Fix `tui.tsx` : chaîne de candidats
> `[<projet>/.mesh, ~/.mesh]` — le premier qui connaît la session
> (identity ou beacon) gagne ; overrides explicites (`meshDir`,
> `MESH_STATE_DIR`) restent stricts. Les toasts `/mesh` suivent le même
> répertoire résolu.

Légende : ✅ fait · 🟡 partiel · ❌ manquant · ➖ sans objet ou accepté.

## 1. Ce qui marche déjà (vérifié en conditions réelles)

| Domaine | Détail |
|---|---|
| **8 tools mesh** | `mesh_send/reply/status/history/wait_all/ledger/reserve/release` — enregistrés et fonctionnels (testés : `mesh_status`). |
| **Guards d'envoi** | `guards.checkSend` branché avant tout aller-retour broker (doublons, caps, boucle). |
| **Auto-release réservations** | `runtime.armAutoRelease` appelé par `mesh_reserve` (`autoReleaseMs`). |
| **Batching entrants** | `InboundBatcher` partagé ; injection `steer`/`queue` via `buildBatchMessage`. |
| **Commande `/mesh`** | `status`, `join <room> [as <alias>] [observer]`, `leave <room>`, `alias [<new>]`, `help` — parseur `parseJoinArgs` partagé avec Pi ; identité persistée après chaque mutation. |
| **Identité par session** | Persistée (`<stateDir>/identity-<sessionId>.json`), alias stable à travers les reloads ; rooms initiales = `default` (sémantique Pi : l'identité persistée gagne). |
| **Attache automatique** | Tout événement de session (`session.tool.success`, `session.step.ended`, `session.reasoning.*`…) attache le runtime — équivalent `session_start` de Pi, pas besoin d'appel d'outil. |
| **Reload-safe** | Génération process-globale + dispose chaîné de l'instance précédente (le host n'appelle pas le cleanup au reload) ; beacon non bloquant (cache peers + refresh en arrière-plan). |
| **Sidebar (CLI plugin)** | `tui.tsx` : alias, état, rooms, **agents visibles** (règle Pi : partage d'au moins une room) avec marqueurs d'activité + marqueur machine distante `⌁` ; beacon 2 s, tolérant aux writers périmés. |
| **Extras OpenCode** | Config `plugins` (v2) + `cli.json`, beacon de statut, disposer inter-instances, ignore des writers étrangers. |

## 2. Bugs corrigés pendant l'audit

1. **`session.prompt is not a function`** (ton test `/mesh join test as test-1`) :
   `attachOpenCodeSession` stockait le **ctx entier** alors que les méthodes
   de session vivent sur `ctx.session`. Le join/renommage réussissait
   (persisté : `test-1` `rooms=default,test`), seule la soumission du texte
   de retour plantait → commande marquée « Failed to set up session ».
   **Fix** : `attachOpenCodeSession` sélectionne `ctx.session` (fallback
   top-level), `submitInto` valide la présence de `prompt` avec un message
   clair.
2. **Instances zombies post-reload** (accumulation de connexions broker,
   alias volés) : fixées par génération + dispose chaîné + attente. Les
   zombies *antérieurs* au fix disparaissent au **prochain redémarrage
   d'OpenCode** (cosmétique, déjà documenté).

## 3. Audit exhaustif — Pi vs OpenCode

### 3.1 Messagerie et cycle de vie

| # | Fonctionnalité Pi | OpenCode | État |
|---|---|---|---|
| 1 | Envoi (to/room/broadcast), priorité `normal/urgent/force`, `refs`, `replyTo` | tools partagés, validation/statuts inclus | ✅ |
| 2 | Statuts honnêtes (`delivered`, `queued_offline`, `blocked`, …) | client partagé | ✅ |
| 3 | Missions `awaitReply` + `mesh_wait_all` | tools présents, mêmes statuts | ✅ (à re-tester bout en bout) |
| 4 | `mesh_reply` par `msgId` (corrélation stricte) | tool présent | ✅ |
| 5 | Injection `normal→queue`, `urgent→steer` | `inject.ts` (map `buildBatchMessage.deliverAs`) | ✅ |
| 6 | **`force` + `interrupt` : abort du tour bloqué du destinataire** | `ctx.session.interrupt` **jamais appelé** côté réception | ❌ (plan 2.3.4) |
| 7 | **Politique entrants** (DM vs broadcast, deferred quand busy, bypasses) | `classifyInbound`/`DeferredInbox` non utilisés | ❌ |
| 8 | **Deferred inbox** (`/mesh inbox`, flush) | absent | ❌ |
| 9 | **Reply hints** anti-boucle (`ReplyHintTracker`) | non branché | ❌ |
| 10 | Batching des rafales | `InboundBatcher` | ✅ |
| 11 | Ledger hash-only + `mesh_ledger` | partagé | ✅ |

### 3.2 Réservations, permissions

| # | Fonctionnalité Pi | OpenCode | État |
|---|---|---|---|
| 12 | `mesh_reserve`/`mesh_release`, TTL, auto-release | tools + `armAutoRelease` | ✅ |
| 13 | **Enforcement : bloquer `edit`/`write` sur chemins réservés par un pair** | aucun hook branché | ❌ — via `ctx.tool.hook("execute.before")` + `ctx.permission.hook("evaluate")` (plan 2.3.5) — **le hook tool n'a pas encore été vu se déclencher, à vérifier** |
| 14 | Conversation de conflit (message qui bloque + alias détenteur) | dépend de 13 | ❌ |

### 3.3 Activité, erreurs, watchdog

| # | Fonctionnalité Pi | OpenCode | État |
|---|---|---|---|
| 15 | Annonces `busy/idle` | `notifyBusy`/`notifyIdle` **définis mais aucun appelant** | 🟡 → brancher sur les événements (`session.*` → busy, `session.idle` → idle) |
| 16 | Détection erreurs provider (quota → `blocked`, 429/5xx → `rate_limited`) | `provider-errors.ts` non branché (pas de `turn_end`) | ❌ → via événements (`step.failed`, erreurs) |
| 17 | **Watchdog M1** (turns dégénérés, compaction + resync) | absent | ❌ → via compteurs d'événements + hook `compaction` |
| 18 | Heartbeat/watchdog client | client partagé | ✅ |

### 3.4 Commande `/mesh` (parité)

| Sous-commande Pi | OpenCode | État |
|---|---|---|
| `status [room]` | ✅ (alias, état, rooms — **vivants** après fix getters) | ✅ |
| `join <room> [as <alias>] [observer]` | ✅ + persistance | ✅ (fix session.prompt) |
| `leave <room>` | ✅ (`not_member` géré) | ✅ |
| `alias [<new>]` | ✅ | ✅ |
| `help` | ✅ | ✅ |
| `ping <alias>` | ✅ (statuts honest : delivered/queued_offline) | ✅ |
| `stale` | ✅ (`buildStaleReport`) | ✅ |
| `broker` | ✅ (socket, lock/pid, compteurs d'échecs) | ✅ |
| `log [on/off]` | ✅ (transcript opt-in) | ✅ |
| `inbox [flush]` | ✅ (deferred inbox branché) | ✅ |
| `reset` | — | ❌ (Phase 2 — reset d'identité ; utile pour OpenCode) |
| `new [--history]` | — | ➖ (concept de session Pi ; l'équivalent OpenCode serait un handoff inter-sessions, hors scope) |

### 3.5 UI / HUD / rendu

| # | Fonctionnalité Pi | OpenCode | État |
|---|---|---|---|
| 19 | HUD : dot, alias, rooms, peers (5 max + overflow), pending, tx, compteurs d'échecs, activité entrante | sidebar : dot, alias, rooms, **agents (illimité)**, activité, `⌁` distant | 🟡 — manquent `pending`, aperçu dernier entrant, `tx on/off`, compteurs d'échecs |
| 20 | Compteur de statut compact (`mesh:n`) | absent (la sidebar suffit) | ➖ |
| 21 | Renderers couleur messages/entry (`mesh-inbound`, `mesh-live`, `mesh-verdict`) | pas d'API équivalente stable ; rendu natif | ➖ accepté (plan 2.3.8) |
| 22 | Slash `/mesh` dans la palette TUI | commande serveur visible dans la palette/slash | ✅ |

### 3.6 Multi-sessions, réglages, packaging

| # | Sujet | État |
|---|---|---|
| 23 | Attache automatique **de toutes les sessions** qui produisent des événements (1 connexion broker chacune, 1 identité chacune) | ⚠️ comportement actuel — aligné Pi (1 peer par session) mais à valider (décision) |
| 24 | Rooms par défaut configurables (`options.rooms`, `MESH_STATE_DIR`, config.json) | ✅ mécanisme en place, non configuré par défaut (voulu) |
| 25 | `MESH_BROKER_URL`/token, TCP/TLS, cross-machine (`via=`) | ✅ client partagé ; marqueur `⌁` dans la sidebar |
| 26 | Skill agent `mesh-coordination/SKILL.md` | ❌ non exposé à OpenCode (pointer `.opencode/skills` ou config `skills`) |
| 27 | Publication npm (`server.ts`, `tui.tsx` dans `files`) | 🟡 prêt mais version 0.7.3 non publiée (npm = 0.7.2) |

## 4. Plan proposé

### Phase 0 — Hygiène (immédiat)
- [x] Fix `session.prompt` (`attachOpenCodeSession` → `ctx.session`).
- [ ] **Redémarrer OpenCode** : purge les connexions zombies des hot-reloads
      de debug (f5bce9, 68e693, 7cc44a, 4cbafe…) ; les fixes de génération
      empêchent toute récidive.
- [ ] Re-tester `/mesh join test as test-1` dans une session → doit répondre
      `mesh: joined test as member (@…, rooms: default, test)`.

### Phase 1 — Parité fonctionnelle essentielle (ordre conseillé)
1. **Force/interrupt à la réception** : sur un batch `deliverAs = "force"`,
   appeler `ctx.session.interrupt({ sessionID, continue: false })` avant la
   soumission (plan 2.3.4). Petit.
2. **Enforcement des réservations** : `ctx.tool.hook("execute.before")` sur
   `edit`/`write` → si conflit (`findConflict`), refuser via
   `ctx.permission.hook("evaluate")` / erreur de tool avec le message Pi.
   *Vérifier d'abord que le hook se déclenche (non observé au 1er essai,
   mais non instrumenté).* Moyen.
3. **Politique entrants + deferred inbox** : brancher `classifyInbound` +
   `DeferredInbox` dans `client-runtime`/`inject` (broadcasts différés
   quand busy), + `/mesh inbox [flush]`. Moyen.
4. **Reply hints** : brancher `ReplyHintTracker` sur l'injection (rappel
   « réponds une fois par msgId »). Petit.
5. **Activité réelle** : `notifyBusy()` sur événements `session.*`,
   `notifyIdle()` sur `session.idle` (aujourd'hui jamais annoncés). Petit.
6. **`/mesh ping`, `stale`, `broker`, `log [on|off]`** : quasi copier-coller
   depuis `extension/commands.ts` (helpers déjà exportés). Petits.

### Phase 2 — Robustesse
7. **Watchdog M1** : compteur d'outils/refus par tour via les événements +
   hook `compaction` pour le resync (parité avec `watchdog.ts`). Moyen.
8. **Erreurs provider** : mapping `step.failed`/erreurs d'événements →
   `rate_limited`/`blocked` + hold des envois. Moyen.
9. **`/mesh reset`** : reset d'identité en place (nouveau client, alias
   neuf, rooms default) — utile sans `/new`. Petit.
10. **Sidebar complète** : `pending`, aperçu du dernier entrant, `tx`,
    compteurs d'échecs (les données existent dans le runtime). Petit.

### Phase 3 — Confort
11. **Skill OpenCode** (`mesh-coordination`) exposé via `.opencode/skills`
    ou l'option `skills`, avec les mêmes règles d'or que Pi.
12. **Publication 0.7.3+** (README déjà à jour ; `server.ts` + `tui.tsx`
    dans `files`).
13. Divers : rendre les compteurs broker visibles, doc cross-machine.

## 5. Décisions à valider

1. **Attacher toutes les sessions OpenCode au mesh** (comportement actuel) ou
   seulement la session active / à la demande ? (Pi = oui, 1 peer/session.)
2. Sidebar : liste des agents illimitée (actuel) ou plafonnée avec `(+n)` ?
3. Alias par défaut : garder `agent-xxxxxx` ou préfixer `oc-` pour
   distinguer les sessions OpenCode dans le mesh ?
4. Priorité Phase 1 : `force/interrupt` d'abord, ou enforcement des
   réservations d'abord ?
