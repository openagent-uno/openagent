# Piano beta: storage normalizzato, history unificata e ricerca globale

Stato: candidate Beta 1 congelato e testato; tag workflow, Friday e rilascio pendenti

Branch: beta/unified-history-ui

Repository coinvolti: openagent-server, openagent-app, openagent-cli, openagent-docs

Release: prerelease beta autorizzata il 2026-08-26; stable non autorizzata

Train: server `0.20.0-beta.1`, app `0.17.0-beta.1`, CLI `0.16.0-beta.1`

Base server del candidate: `v0.19.26` (`dcf39f77c7e25738a15517817a5ebed97a9d5490`); rebase completato, gate finali pendenti

Ultimo aggiornamento: 2026-08-26

## Pacchetto di specifica

La vision resta la fonte di verità. Questo piano è l'indice cross-repository; i
contratti normativi e verificabili sono:

- [ADR-001: storage operativo SQLite-first](../architecture/adr-001-operational-storage-sqlite-first.md);
- [ADR-002: storia canonica, compaction e retention](../architecture/adr-002-canonical-history-retention.md);
- [ADR-003: indice testuale operativo](../architecture/adr-003-operational-search-index.md);
- DDL canonica v2: `architecture/operational-storage-v2.sql`;
- bridge trigger per la tabella legacy: `architecture/legacy-session-change-triggers.sql`;
- bridge trigger per le automazioni legacy: `architecture/legacy-automation-change-triggers.sql`;
- DDL indice operativo v1: `architecture/operational-search-v1.sql`;
- [OpenAPI history e search](../api/unified-history-search.openapi.yaml);
- [SearchTarget e DTO TypeScript](../api/search-target.ts);
- [threat model](../security/operational-search-threat-model.md);
- [specifica visuale e ricerca globale](../design/global-search-visual-refresh-spec.md);
- [piano di verifica cross-repository](../testing/unified-history-search-verification.md);
- [runbook beta](../release/beta-unified-history-runbook.md).

In caso di conflitto: vision, ADR approvati, OpenAPI/DDL e infine questo piano.
Ogni modifica di implementazione dovrà citare il requisito e il test che soddisfa.

::: info Freeze DDL completato
Le quattro copie SQL in `architecture/` coincidono byte per byte con gli
schemi runtime del candidate dopo l'audit operativo. Il rollout usa comunque i
file inclusi nel package server; le copie documentali restano riferimenti
revisionati e devono essere ricontrollate per hash a ogni modifica dello schema.
:::

## 1. Obiettivo

Ridisegnare la persistenza operativa di OpenAgent e le superfici client in modo che:

1. ogni sessione sia conservata con full fidelity senza riscrivere l'intero transcript a ogni turno;
2. chat, workflow, scheduled task ed eventi compaiano in una history unica, completa e paginabile;
3. il client offra una ricerca globale simile, per velocità e immediatezza, a quella di Codex;
4. la ricerca trovi non soltanto nomi e titoli, ma anche ciò che è avvenuto dentro le risorse:
   - messaggi user e assistant;
   - prompt e output;
   - chiamate tool, argomenti e risultati testuali autorizzati;
   - errori;
   - step e trace di workflow;
   - run schedulati;
   - delivery e run causati da eventi;
   - child session e delegazioni;
5. ogni risultato apra il client nel punto esatto che ha prodotto il match;
6. la baseline resti self-hosted, offline e zero-config;
7. migrazione e rollback siano sicuri durante l'intero canale beta.

Il risultato non deve introdurre una seconda memoria opaca. La storia canonica resta distinta dal memory vault e gli indici sono sempre cache ricostruibili.

## 2. Vincoli derivati dalla vision

Le decisioni di questo piano derivano direttamente da vision.md:

- il server possiede stato e history; app e CLI sono client sottili;
- il memory vault resta Markdown human-readable e Git-backed;
- un indice full-text o semantico può esistere soltanto come cache ricostruibile;
- le sessioni sono durevoli e full-fidelity;
- ogni messaggio conserva l'autore;
- file, tool call, delegazioni e reasoning reso visibile fanno parte della sessione;
- compaction del contesto modello non può distruggere la storia canonica;
- l'istanza deve poter funzionare offline senza un database o servizio cloud obbligatorio;
- la rimozione di un provider non può eliminare la capacità di cercare la propria storia.

## 3. Decisioni architetturali accettate per la beta

Queste decisioni sono formalizzate negli ADR collegati sopra. Prima
dell'implementazione possono cambiare soltanto aggiornando insieme ADR, contratti e
test interessati.

### 3.1 Motore dati

- SQLite normalizzato resta il backend locale predefinito.
- Non si introduce MongoDB come dipendenza obbligatoria.
- Si introduce un repository di dominio per evitare nuovo coupling al motore.
- Un backend PostgreSQL opzionale potrà essere aggiunto dopo benchmark e SLO reali.
- Il passaggio a un database client/server non è un prerequisito per questa beta.

### 3.2 Fonti canoniche e indici

- Il vault Markdown resta la fonte canonica della memoria.
- In shadow il blob legacy resta canonico e v2 viene confrontato.
- In prefer_v2 la fonte viene scelta per singola sessione soltanto quando quella sessione è completa e verificata.
- In v2 le nuove tabelle diventano la fonte canonica della storia operativa.
- Il vecchio campo sessions.runs resta scritto durante la beta esclusivamente per compatibilità e rollback.
- Blob legacy, righe v2, activity projection, domain event e search outbox devono essere aggiornati da un solo repository/writer e nella stessa transazione SQLite.
- L'indice FTS del vault resta separato.
- L'indice operativo globale per chat e automazioni è un'altra cache, separata e cancellabile.
- L'indice semantico resta opzionale e separato; non è necessario per la ricerca testuale iniziale.

### 3.3 API

- GET /api/history serve il feed cronologico e non dipende dall'FTS.
- POST /api/search serve la ricerca globale ricca.
- GET /api/sessions/{id}/messages supporta cursor e apertura intorno a un anchor.
- Gli endpoint legacy rimangono disponibili durante beta e almeno una stable successiva.

### 3.4 Client

- La ricerca è globale e montata nella shell autenticata, non soltanto nella schermata chat.
- Il layout generale, i colori e i blur esistenti restano invariati.
- La ricerca è disponibile dalla sidebar e da tastiera.
- I risultati sono server-side, paginati e account-scoped.

### 3.5 Release

- Tutto il lavoro resta su beta/unified-history-ui.
- L'autorizzazione esplicita al train beta è registrata il 2026-08-26; non
  equivale alla prova che i gate siano già passati.
- Dopo i gate, le release beta sono GitHub prerelease con
  `prerelease=true` e `make_latest=false`.
- Stable, mutazione di `latest`, riuso di tag e salto dei gate restano non
  autorizzati.

## 4. Scope

### 4.1 In scope

- storage normalizzato delle sessioni;
- persistenza durevole di messaggi, tool, artefatti e child session;
- separazione tra storia canonica e contesto compatto del modello;
- schema migrations reale;
- backup pre-migrazione e rollback;
- ownership e autorizzazione coerenti;
- proiezione unificata della history;
- indice testuale operativo globale;
- ricerca globale server, app, agent e CLI;
- deep-link verso messaggi, tool call, run e step;
- realtime e invalidazione;
- capability negotiation tra versioni indipendenti;
- font e pulizia visuale richiesti;
- canale beta e prerelease GitHub;
- test, benchmark, osservabilità e dogfood.

### 4.2 Non-goal della prima beta

- sostituire il vault Markdown con un database;
- fondere vault FTS e indice delle conversazioni;
- rendere MongoDB obbligatorio;
- sharding o deployment multi-region;
- semantic search obbligatoria;
- indicizzazione raw di credenziali, header, token o payload arbitrari;
- ricerca dentro media binari senza una pipeline di estrazione esplicita;
- rimozione immediata di sessions.runs;
- modifica di palette colori, blur o layout principale;
- pubblicazione di una release prima dei gate.

## 5. Problemi verificati nello stato corrente

### 5.1 Sessioni

- Una sessione occupa una sola riga in sessions.
- L'intero array dei run vive nel campo JSON runs.
- Ogni upsert riserializza e riscrive tutto il transcript.
- I campi usati per owner, titolo, origin e parent sono dentro metadata JSON, talvolta double-encoded.
- La lettura degli ultimi N run deserializza comunque tutto il blob.
- La compaction e la retention correnti possono eliminare storia canonica.
- Tool call e risultati sono duplicati in più shape JSON e non hanno identità relazionale stabile.
- Allegati e tool output grandi possono dipendere da file temporanei o retention limitata.

### 5.2 Sidebar e history

- GET /api/sessions restituisce 50 sessioni di default e non offre cursor.
- L'app carica chat separatamente.
- Workflow, scheduled task ed eventi richiedono una lista genitore e un fan-out dei rispettivi run.
- Un refresh può arrivare a circa 124 richieste.
- Le categorie compaiono in momenti diversi.
- La sidebar tronca localmente i risultati.
- Un resource event può rilanciare l'intero fan-out.

### 5.3 Ricerca

- Il quick switcher corrente cerca soltanto chat già idratate nel client.
- Il transcript FTS indicizza soltanto user/assistant e riparsa un'intera sessione quando cambia.
- Non esiste un endpoint REST globale.
- Titoli, owner, tool call, workflow, scheduled task ed eventi non fanno parte dello stesso corpus.
- L'indice semantico corrente non è pronto per tenancy e ACL.
- Il vault ha un proprio FTS e non deve essere confuso con la ricerca della history.

### 5.4 Migrazioni e rollback

- Le migrazioni principali sono una sequenza di alter idempotenti eseguita al boot.
- Non esiste un ledger unico con checksum, stato e checkpoint.
- Il rollback dell'updater protegge il binario, non il database.
- Copiare openagent.db mentre il WAL è attivo non è un backup affidabile.

### 5.5 Release beta

- I workflow GitHub beta validano tag/versioni `vX.Y.Z-beta.N`, eseguono test e
  package smoke nativi, verificano l'unione esatta degli asset e producono
  attestazioni; la presenza di questi job non costituisce ancora evidenza di
  una loro esecuzione riuscita.
- Il push del tag avvia ancora build e preparazione della release nello stesso
  workflow. La pubblicazione è però visibility-atomic: gli asset vengono
  caricati in un draft nascosto con overwrite disabilitato, quindi nomi, size e
  digest GitHub `sha256:` vengono confrontati byte-per-byte; solo dopo il draft
  passa a `prerelease=true`, `draft=false`, `make_latest=false`.
- Il server updater packaged/frozen resta stable di default su
  `releases/latest`; `auto_update.channel: beta` o, in sua assenza,
  `OPENAGENT_UPDATE_CHANNEL=beta` abilita esplicitamente il feed delle release.
  Il canale beta accetta soltanto beta compatibili o una stable semanticamente
  più nuova e fallisce chiuso su asset/digest non verificabili; un valore canale
  sconosciuto ricade su stable. La selezione del canale non abilita da sola il
  job `auto_update`.
- L'updater beta server accetta prerelease sulla major/minor già installata:
  Friday su `0.19.x` non seleziona automaticamente `0.20.0-beta.1`. Il seed è
  quindi manuale dal package Linux x64 pubblicato, dopo verifica combinata del
  checksum sibling e del digest GitHub; dalla beta installata gli update
  successivi restano sulla linea compatibile `0.20`.
- Un'app installata da un artifact `-beta.N` seleziona il canale beta e abilita
  prerelease; una build stable resta su `latest`. Non esiste ancora un channel
  picker persistente nell'UI.
- Il CLI non ha un self-updater: la prima beta usa installazione manuale
  dell'artifact. Gli script interattivi `release.sh` non sono la procedura beta.

## 6. Architettura target

~~~mermaid
flowchart LR
    subgraph Sources["Fonti canoniche"]
        Vault["Vault Markdown + Git"]
        Core["openagent.db normalizzato"]
        Artifacts["Artifact store content-addressed"]
        Logs["events.jsonl"]
    end

    subgraph CoreViews["Proiezioni nello storage operativo"]
        Activity["activity_items"]
        Outbox["search_outbox"]
        Context["context_snapshots"]
    end

    subgraph Derived["Cache ricostruibili"]
        VaultFTS["vault_index_*.db"]
        SearchFTS["operational_search_*.db"]
        Semantic["semantic_index_*.db opzionale"]
    end

    Core --> Activity
    Core --> Outbox
    Core --> Context
    Outbox --> SearchFTS
    Vault --> VaultFTS
    Vault -. opt-in .-> Semantic
    Core -. opt-in .-> Semantic
    Core --> Artifacts

    Activity --> HistoryAPI["GET /api/history"]
    SearchFTS --> OperationalSearch["OperationalSearchService"]
    OperationalSearch --> SearchAPI["POST /api/search"]
    VaultFTS --> VaultSearch["VaultSearchService"]
    Semantic -. workstream futuro .-> OperationalSearch
    Semantic -. workstream futuro .-> VaultSearch

    HistoryAPI --> Clients["App · CLI · integrations"]
    SearchAPI --> Clients
    OperationalSearch --> AgentHistory["agent history recall"]
    VaultSearch --> AgentMemory["memory-search MCP"]
~~~

I due servizi possono condividere primitive di query, ACL e health, ma non fonte canonica, indice, lifecycle o semantica dei risultati. La prima beta espone nel client soltanto `OperationalSearchService`; `VaultSearchService` continua a servire il memory vault separatamente.

## 7. Layout dello storage locale

| Elemento | Ruolo | Canonico | Ricostruibile |
|---|---|---:|---:|
| openagent.db | Stato operativo normalizzato | sì | no |
| memories/*.md | Memory vault | sì | no |
| vault git history | Provenienza del vault | sì | no |
| artifacts/objects/* | File, allegati e output grandi | sì | no |
| logs/events.jsonl | Journal operativo strutturato | sì, per il logging | no |
| vault_index_*.db | Ricerca/graph del vault | no | sì |
| operational_search_*.db | Ricerca globale operativa | no | sì |
| semantic_index_*.db | Recall semantica opt-in | no | sì |
| backups/* | Snapshot pre-migrazione | copia di sicurezza | rigenerabile solo da una fonte integra |
| openagent.yaml | Bootstrap/configurazione | sì | no |
| chiavi e certificati | Identità | sì | no |

Gli indici derivati devono avere:

- source fingerprint;
- index kind;
- schema version;
- extractor version;
- redaction version;
- last indexed outbox sequence;
- coverage;
- last error;
- rebuild sicuro.

I path di cache, fonte e altri indici non possono coincidere.

## 8. Schema canonico v2

I nomi definitivi saranno fissati nell'ADR/DDL. Durante la beta è preferibile usare tabelle additive, anche con suffisso v2, per non alterare il contratto del runtime legacy.

### 8.1 Migrazioni

schema_migrations:

- migration_id;
- checksum;
- description;
- status: pending, running, complete, failed;
- started_at;
- completed_at;
- app_version;
- error_class.

storage_migration_state:

- phase: legacy, shadow, prefer_v2, v2;
- checkpoint_updated_at;
- checkpoint_session_id;
- batch_size;
- migrated_sessions;
- failed_sessions;
- source_hash;
- last_writer_version;
- last_writer_epoch;
- updated_at.

legacy_session_changes:

- seq;
- session_id;
- operation: insert, update, delete;
- legacy_updated_at quando disponibile;
- observed_at.

Trigger SQLite additive su sessions alimentano questo journal anche quando scrive un binary pre-v2 che non conosce il nuovo schema. Il writer beta consuma/riconcilia le entry e registra l'ultimo seq applicato.

Coordinamento:

- un solo migration leader acquisisce un file lock OS accanto al DB;
- il leader verifica il lock anche con BEGIN IMMEDIATE prima di DDL o cambio fase;
- scheduler e subprocessi che possono toccare lo storage partono soltanto dopo backup e DDL;
- ogni binary dichiara schema_min e schema_max compatibili;
- un binary incompatibile fallisce prima di aprire writer secondari;
- il backfill usa checkpoint composto updated_at + session_id, non un id isolato;
- ogni batch rilegge source_version/source_hash prima del commit;
- l'upsert è condizionale e rimette in coda una sessione cambiata durante l'estrazione.

### 8.2 Session header

sessions_v2:

- id;
- tenant_id;
- owner_principal_id;
- owner_handle_snapshot per display;
- visibility;
- acl_version;
- title;
- session_type;
- kind;
- origin;
- parent_session_id;
- root_session_id;
- agent_id;
- team_id;
- workflow_id;
- model;
- framework;
- status di lifecycle della sessione, distinto da RunStatus;
- completeness;
- created_at;
- updated_at;
- last_activity_at;
- legacy_source_hash;
- metadata_json per i soli campi non interrogabili.

Campi usati per filtro, sort, join o autorizzazione devono essere colonne vere.

### 8.3 Run

session_runs:

- id;
- session_id;
- ordinal;
- idempotency_key;
- parent_run_id;
- runner_kind;
- agent_id;
- team_id;
- workflow_id;
- workflow_step_id;
- status normalizzato su RunStatus wire;
- status_raw lossless dalla fonte runtime/legacy;
- model;
- model_provider;
- input_json;
- output_json;
- metrics_json;
- metadata_json;
- created_at;
- finished_at;
- source_version;
- completeness: complete, partial, legacy_compacted, malformed_source, unknown;
- raw_envelope_json versionato e forward-compatible;
- raw_envelope_schema;
- legacy_raw_json opzionale durante il solo backfill.

L'envelope raw per-record conserva i campi non ancora normalizzati, inclusi metadata provider, citations/references, follow-up, requirements/eventi, state forward-compatible e reasoning step resi visibili. Non può ricreare un blob per-sessione.

Indici minimi:

- unique(session_id, ordinal);
- session_id, created_at, id;
- parent_run_id;
- workflow_id, workflow_step_id;
- status, created_at.

### 8.4 Messaggi

session_messages:

- id stabile;
- session_id;
- run_id;
- ordinal;
- idempotency_key;
- role: user, assistant, tool, compaction;
- status: streaming, complete, interrupted, cancelled, failed;
- author_kind: user, agent, system;
- author_principal_id;
- author_handle_snapshot;
- author_display;
- author_device_id;
- name;
- text;
- content_json per la shape multimodale;
- compressed_content;
- reasoning_content visibile;
- redacted_reasoning_content;
- tool_call_id quando il messaggio è collegato a un tool;
- visibility;
- created_at;
- source_version;
- completeness: complete, partial, legacy_compacted, malformed_source, unknown;
- raw_envelope_json versionato;
- raw_envelope_schema;
- legacy_inferred.

Non devono diventare messaggi ricercabili:

- framework system prompt;
- hidden reasoning;
- provider-private payload;
- stato runtime non visibile.

session_message_parts, se necessario:

- message_id;
- ordinal;
- kind: text, image, audio, video, file, reference;
- text;
- artifact_id;
- mime;
- metadata_json.

### 8.5 Tool invocation

tool_invocations deve coprire sia tool chiamati in una sessione AI sia tool/MCP eseguiti da uno step workflow deterministico.

Campi:

- id;
- tenant_id;
- owner_principal_id;
- visibility;
- acl_version;
- root_kind;
- root_id;
- session_id;
- session_run_id;
- workflow_run_id;
- workflow_step_id;
- task_run_id;
- event_delivery_id;
- ordinal;
- tool_call_id;
- tool_server;
- tool_name;
- status normalizzato su ToolInvocationStatus wire;
- status_raw lossless dalla fonte runtime/legacy;
- args_json canonico;
- result_json canonico;
- result_text canonico;
- error canonico;
- child_run_id;
- child_session_id;
- approval/HITL metadata;
- sensitivity;
- artifact_id;
- sha256;
- size_bytes;
- created_at;
- finished_at;
- completeness: complete, partial, legacy_compacted, malformed_source, unknown;
- legacy_inferred.

Quando tool_call_id è presente, l'identità è almeno context + tool_call_id. Per record legacy senza id si usa un id sintetico deterministico basato su session, run e ordinal. Non si deduplica mai soltanto per tool_name.

### 8.6 Artefatti

artifacts:

- id;
- tenant_id;
- owner_principal_id;
- visibility;
- resource_type;
- resource_id;
- direction;
- kind;
- mime;
- filename;
- storage_key;
- sha256;
- size_bytes;
- metadata_json;
- retention_class;
- ref_count;
- created_at.

I byte vivono fuori dal DB:

- path content-addressed;
- write atomico;
- hash verificato;
- permessi restrittivi;
- reference counting;
- nessuna dipendenza da directory temporanee per contenuti che fanno parte della storia.

### 8.7 Compaction

context_snapshots:

- id;
- session_id;
- model/runtime target;
- summary;
- exact folded_from_sequence/message_id;
- exact folded_to_sequence/message_id;
- token estimate;
- tokenizer;
- source_revision;
- source_checksum;
- predecessor_snapshot_id;
- created_at;
- superseded_at.

La compaction crea una proiezione del contesto che il modello vede. Non aggiorna né cancella session_messages, tool_invocations o artifacts.

### 8.8 Workflow trace

workflow_trace_steps:

- id;
- workflow_run_id;
- seq;
- node_id;
- attempt;
- type;
- status;
- started_at;
- finished_at;
- input_json canonico;
- output_json canonico;
- error canonico;
- child_session_id.

La chiave non può essere soltanto run + node_id: loop e retry possono eseguire più volte lo stesso nodo.

### 8.9 ACL

Ogni risorsa ricercabile deve avere tenant_id, owner_principal_id, visibility e acl_version. Handle e display name non sono identità stabili e restano attributi presentazionali.

resource_acl:

- tenant_id;
- resource_type;
- resource_id;
- principal_type;
- principal_id;
- permission: view, search, reveal_sensitive, admin.

Default di migrazione:

- sessione top-level: privata soltanto quando il principal è ricavabile deterministicamente dalla provenance;
- child session: eredita la root;
- workflow/task/event nuovi: ownership dal principal autenticato o installation scope esplicito;
- definition e run legacy di workflow/task/event che il contratto legacy rendeva
  installation-wide: `installation_shared`, owner umano nullo, provenance
  `legacy_unattributed`, policy applicata e completeness registrate
  esplicitamente;
- sessione/chat ownerless, oppure record legacy non riconosciuto come
  installation-wide: quarantena/fail-closed e remediation;
- run: eredita la definition/root che lo ha prodotto;
- record ownerless ambiguo su server multi-user: fail closed e remediation;
- per i nuovi record owner, tenant e visibility derivano soltanto dal contesto
  auth/cert server-side e non da query parameter o payload controllati dal client.

### 8.10 History projection

activity_items è una proiezione leggera, transazionalmente aggiornata e ricostruibile:

- activity_id;
- kind: chat, delegated_session, workflow_run, scheduled_run, event_delivery;
- resource_type;
- resource_id;
- parent_type;
- parent_id;
- session_id;
- tenant_id;
- owner_principal_id;
- visibility;
- status;
- title;
- origin;
- occurred_at;
- updated_at;
- source_version.

Non contiene:

- graph;
- trace;
- transcript;
- payload;
- tool output;
- segreti.

Serve esclusivamente a lista, filtri, cursor e realtime summary.

Le sessioni delegate richieste dalla vision sono first-class:

- appaiono raggruppate/nidificate sotto la sessione che le ha create;
- sono filtrabili e apribili;
- non vengono nascoste come semplici implementation detail;
- soltanto le child session causali di workflow/scheduled/event vengono assorbite dalla relativa root activity per evitare duplicati;
- quando esistono sia durable child session sia member_responses nested, la child session è canonica e il nested è una proiezione/link;
- legacy nested-only viene materializzato una volta o marcato inferred, mai contato due volte.

### 8.11 Search outbox

search_outbox vive nel DB canonico ed è scritto nella stessa transazione della fonte:

- seq monotonic;
- source_kind;
- source_id;
- operation: upsert, delete, acl_change, rebuild;
- source_version;
- acl_version;
- committed_at.

Il worker:

- è idempotente;
- consuma per seq;
- checkpointa;
- recupera dopo crash;
- non blocca il turn path con parsing o indicizzazione di output grandi;
- emette lag, coverage ed errori;
- non indicizza stream delta, soltanto unità finali/durevoli.

### 8.12 Protocollo di durabilità e writer unico

Il SessionRepository è il solo boundary autorizzato a scrivere storia. MemoryDB, runtime SQLAlchemy e subprocessi non possono più aggiornare direttamente le stesse risorse con transazioni indipendenti.

Sequenza minima di un turno:

1. creare/aggiornare session header;
2. persistere il messaggio user e l'idempotency key prima della chiamata provider;
3. creare il run in status pending, poi portarlo a running prima della chiamata provider;
4. creare il messaggio assistant in status streaming;
5. checkpointare contenuto streaming a intervalli bounded, aggiornando soltanto quel messaggio;
6. persistere una tool invocation in status pending prima dell'esecuzione;
7. persistere status/result/error raw prima di emettere il risultato definitivo al client;
8. acquisire il raw tool output prima di qualsiasi cap o trasformazione di display; output grande va in artifact store copy-only durante beta;
9. finalizzare il messaggio assistant come complete e il run come success; sui path non-success usare le rispettive enum message/run interrupted, cancelled o failed;
10. nella stessa transazione di ogni stato durevole aggiornare legacy blob, v2, activity, domain event e outbox.

Retry e reconnect usano idempotency key stabili. Un crash lascia record espliciti interrupted/streaming-recovered, non cancella ciò che il client ha già visto.

### 8.13 Domain event log

activity_items e search_outbox non sostituiscono il single structured log della vision.

domain_events è un journal append-only condiviso:

- sequence globale;
- event id;
- tenant/principal;
- resource type/id;
- session/run/tool/step id;
- event type;
- timestamp;
- metadata strutturati e redatti;
- correlation/causation id;
- schema version.

Viene scritto nella transazione canonica e alimenta il logger JSONL/realtime. È un witness e una fonte di osservabilità, non sostituisce le tabelle full-fidelity per ricostruire la sessione.

## 9. Indice operativo globale

L'indice beta vive in `operational_search_<sourcehash>.db`, separato da `openagent.db` e da `vault_index`.

### 9.1 Documenti, chunk e ACL

Un documento rappresenta una singola unità ricercabile:

- metadata di sessione;
- messaggio;
- tool invocation;
- workflow definition;
- workflow run;
- workflow step;
- scheduled task definition;
- scheduled run;
- event definition;
- event delivery.

`search_documents` conserva metadata, target e autorizzazione della proiezione:

- document_rowid e doc_id;
- document_kind, resource_type/resource_id;
- root_kind/root_id e parent_type/parent_id;
- session_id, session_run_id e gli ID tipizzati necessari al SearchTarget;
- tenant_id, owner_principal_id, visibility e acl_version;
- status, origin e author_principal_id;
- title_safe e author_display_safe;
- occurred_at_ms e updated_at_ms;
- source, extractor e redaction version;
- sensitivity, completeness, content_hash e deleted_at_ms.

`search_chunks` conserva soltanto metadata bounded:

- chunk_rowid e chunk_id;
- document_rowid e ordinal;
- match_kind e source_field;
- indexed_chars e content_hash.

I campi testuali safe vivono nella FTS contentful e condividono il rowid del chunk.
La tabella metadata non duplica il testo. Documenti grandi vengono spezzati in righe
reali e non affidati a una promessa astratta di chunking.

`search_identifiers` conserva soltanto identificatori normalizzati e display-safe per
il lookup esatto B-tree prima del ranking full-text.

`search_acl_grants` contiene tenant_id, document_rowid, principal, permission e
acl_version. La FK composita document_rowid/tenant_id impedisce grant cross-tenant
anche nella cache derivata. La proiezione viene aggiornata dalla stessa outbox degli
altri documenti. Un ACL/subtree change invalida fail-closed la versione precedente.
In alternativa, per un deployment con pochi principal, il server materializza prima
l'insieme autorizzato di resource id e soltanto dopo interroga i candidati FTS.

`query_snapshots`, `query_snapshot_items` e `query_snapshot_hits` contengono:

- snapshot id;
- tenant/principal/ACL binding;
- digest keyed di query e filtri;
- index_generation e indexed_seq di partenza;
- created_at/expires_at;
- root/doc/activity id ordinati e score/order;
- al massimo due riferimenti a hit per risultato;
- limite massimo di candidati per evitare snapshot illimitati.

Sono dati effimeri senza query, snippet, body o transcript. Vengono eliminati a
TTL/logout e rendono stabile la paginazione mentre l'indice continua ad aggiornarsi.
La history non dipende da questo database: il suo cursor/snapshot è risolto dal
servizio canonico di activity.

### 9.2 FTS5

`search_fts` contiene soltanto testo redatto:

- title_safe;
- author_search_safe;
- body_safe;
- keywords_safe;
- identifiers_safe;
- tokenizer unicode61 con rimozione diacritici;
- prefix index valutato via benchmark;
- BM25 pesato.

Non si usa una virtual table external-content aggiornata da trigger: con
`trusted_schema=OFF` i build SQLite supportati rifiutano l'invocazione FTS dentro un
trigger. L'indexer inserisce, aggiorna o elimina `search_chunks` e `search_fts` nella
stessa transazione, con rowid uguale. Prima di promuovere una generazione verifica
che i due insiemi di rowid coincidano; qualsiasi mismatch invalida e ricostruisce la
cache derivata.

Pesi iniziali da validare:

- identificatori: 12;
- titolo/nome: 8;
- tool, node label e keyword: 4;
- autore: 2;
- corpo: 1.

La query dell'utente è letterale per default. Le virgolette possono indicare una frase, ma la sintassi FTS raw non viene esposta direttamente.

### 9.3 Ranking

Ordine di massima:

1. exact id/name;
2. prefix del titolo;
3. frase nel titolo o contenuto;
4. tool name/node label;
5. BM25 sul corpo;
6. piccolo recency boost.

Regole:

- la recency non può seppellire un exact match vecchio;
- i risultati sono raggruppati per root;
- una chat con 30 match produce una card con il miglior passaggio, un secondo passaggio opzionale e match_count;
- il filtro Tools può produrre una riga per invocation;
- una delegated session resta un elemento di history di prima classe, raggruppabile sotto il parent e con deep-link proprio;
- una child session causale di workflow, scheduled run o event delivery resta sotto quella root causale e conserva il deep-link;
- la vista All applica quote per categoria o fusion per impedire a un corpus enorme di monopolizzare la prima pagina;
- score di FTS vault, FTS operativo e semantic non vengono confrontati direttamente;
- se si fondono corpora diversi si usa Reciprocal Rank Fusion con source label.

La prima beta non fonde vault o semantic: usa un solo indice operativo, quindi non richiede RRF cross-index. Eventuale bilanciamento fra categorie deve essere deterministico e salvato nello snapshot della query; non può cambiare fra pagina 1 e pagina 2.

### 9.4 Coverage

Ogni risposta dichiara:

- complete;
- indexed_documents;
- estimated_total;
- pending;
- indexed_through;
- lag_ms;
- last_error;
- per_corpus.

Un indice in warm-up non deve rispondere come se un risultato vuoto fosse completo.

Stato indice:

- index_generation cambia soltanto su rebuild, schema o redaction version;
- indexed_seq avanza a ogni outbox applicata;
- history_revision avanza sulle sole activity mutation;
- cursor e UI non usano un'unica revision per concetti diversi.

Un rebuild con ACL/redaction incompatibili elimina e ricostruisce anche i vecchi transcript/semantic cache che contenevano testo raw senza tenant.

## 10. Matrice dei contenuti ricercabili

| Categoria | Contenuto canonico | Contenuto indicizzato di default | Anchor |
|---|---|---|---|
| Chat | session header | titolo, origin, model, id | session |
| Messaggio | testo e parti | testo user/assistant/seed visibile, autore | message |
| Tool in chat | args/result/error full fidelity | nome, status, args/result sanitizzati, errore sanitizzato | tool invocation |
| Delegated session | session completa | elemento di prima classe, raggruppato/nested sotto il parent | child message/tool |
| Child causale di workflow/scheduled/event | session completa | match assorbito sotto la root causale con breadcrumb | child message/tool |
| Workflow definition | graph completo | nome, descrizione, label/type dei nodi, prompt sanitizzati, tool name | workflow root; node/field follow-up |
| Workflow run | inputs/outputs/error/trace | trigger, status, summary safe, errore safe | run |
| Workflow step | input/output/error completo | label/type, testo safe, errore safe, child link | workflow run; trace-step follow-up |
| Scheduled task | prompt e schedule | nome, prompt sanitizzato, cron, timezone, model | task root; field follow-up |
| Scheduled run | output/error/session | status, output/error safe e transcript collegato | run; nested anchor follow-up |
| Event definition | config e schema | nome, descrizione, type, action, field name/description | event root; field follow-up |
| Event delivery | payload/output/error/link | source, status, output/error safe; payload solo allowlist | delivery; nested anchor follow-up |
| Vault, fuori dalla prima beta globale | Markdown | indice vault esistente e separato | note/path |
| Artifact | byte canonici | filename e testo estratto soltanto con policy/opt-in | artifact |

## 11. Ricerca nelle chiamate tool

La ricerca dei tool è un requisito della feature, non un'estensione futura.

### 11.1 Cosa deve funzionare

L'utente deve poter cercare:

- nome del tool;
- server/MCP;
- status;
- path o identificatori non sensibili negli argomenti;
- testo user-visible negli argomenti;
- risultato testuale mostrato nella sessione;
- errori;
- tool chiamati dentro chat, workflow, scheduled run ed event run;
- child session prodotta dal tool.

### 11.2 Separazione canonical/search

- args e result completi sono conservati nel canonico, rispettando ACL e artifact store;
- l'FTS contiene soltanto una proiezione redatta;
- il risultato di ricerca apre la invocation canonica;
- l'indice non è mai usato per ricostruire il dettaglio;
- un delete/revoke viene ricontrollato sul canonico prima della serializzazione.

### 11.3 Estrazione e redazione

Pipeline:

1. estrazione strutturale per tool noto;
2. annotazioni per campo: searchable, sensitive, large;
3. denylist case-insensitive per password, secret, token, api_key, authorization, cookie, headers, credential e private key;
4. scrub delle query string URL;
5. riconoscimento JWT, bearer token, PEM key e stringhe ad alta entropia;
6. flatten soltanto di scalar text autorizzati da schema/annotazione/extractor;
7. chunk dei testi grandi;
8. output body_safe con redaction_version;
9. test di assenza dei segreti anche nei byte del search DB.

Per tool built-in si definiscono extractor espliciti.

Per tool sconosciuti:

- indicizzare sempre tool name, server, status, key names, tipi, id pubblici e dimensioni;
- non indicizzare scalar value soltanto sulla base di denylist o detector;
- valori testuali entrano nell'FTS solo se uno schema/annotazione o extractor approvato li marca searchable;
- segnare partial quando una parte è esclusa;
- non indicizzare binary/base64;
- non indicizzare file esterni letti dal tool se quel testo non è già contenuto user-visible nel transcript, salvo opt-in.

### 11.4 Output grandi

- nessuna riscrittura del blob sessione;
- il canonico usa artifact reference;
- l'indicizzatore lavora a chunk;
- il limite per documento è configurabile;
- se un limite globale impedisce copertura completa, completeness=partial viene mostrato;
- la prima beta deve definire e misurare un massimo sicuro, non troncare silenziosamente.

### 11.5 Reveal sensibile

La ricerca normale non deve mai restituire raw secret.

Un eventuale futuro reveal:

- richiede permission reveal_sensitive;
- usa endpoint detail separato;
- non inserisce il contenuto nei log;
- registra soltanto attore, invocation id, motivo e timestamp;
- restituisce 404 cross-owner.

La ricerca full-text dentro raw values arbitrari non è default: un FTS efficiente richiederebbe plaintext indicizzato. Se richiesta, sarà una modalità locale opt-in oppure uno scan canonico bounded dopo filtro ACL/tool/date.

## 12. Contenuti da non indicizzare raw

Mai:

- provider api keys;
- MCP env, headers e credential;
- event secret_enc o secret_hint;
- authorization header, cookie e token;
- framework system prompt;
- hidden reasoning;
- provider_data e session_state privati;
- agent_data/team_data/workflow_data;
- raw stack trace;
- media bytes o base64;
- signed URL;
- chiavi/certificati;
- queue claim, lease, worker id;
- raw log;
- webhook payload completo;
- workflow HTTP header/body o variabili segrete;
- raw tool content marcato sensitive.

Event payload:

- default non indicizzato;
- input_schema può dichiarare searchable=true per singoli field;
- il downstream transcript/output resta ricercabile;
- la UI segnala quando il payload non è incluso.

Reasoning:

- soltanto reasoning già visibile all'utente;
- hidden o provider-redacted non entra nel documento search.

## 13. Autorizzazione

### 13.1 Regola fondamentale

L'ACL viene applicata prima di candidate limit, snippet, count restituito e serializzazione. Ranking e corpus statistics possono usare strutture interne globali, ma non possono far entrare candidati non autorizzati nella finestra visibile.

Difesa in profondità:

1. il search DB filtra tenant, principal grant/ACL bucket, visibility e acl_version;
2. il server reidrata i candidati a batch;
3. l'AccessResolver ricontrolla la fonte canonica;
4. candidati revocati vengono scartati e sostituiti prima della risposta;
5. nessun contenuto, count o snippet espone documenti non autorizzati;
6. side-channel temporali vengono ridotti e testati best-effort, senza promettere l'assenza assoluta di timing leak.

### 13.2 Principal

Principal possibili, sempre con identificatore stabile e immutabile:

- `user:<principal_uuid>`;
- `agent:<agent_id>`;
- `device:<public_key_fingerprint>`;
- `system:<instance_id>`.

Handle, nome e label sono snapshot di display e non partecipano all'identità o alla decisione ACL.

Il principal arriva dal middleware di autenticazione. Non viene letto da query param o body.

Quando l'agent cerca durante un turno:

- il contesto server include il principal on-behalf-of;
- il modello non può scegliere un owner arbitrario;
- il recall della storia operativa usa OperationalSearchService in-process oppure una capability non falsificabile;
- il memory-search MCP continua a usare VaultSearchService e non viene fuso implicitamente con la storia;
- ricerca agent-side, UI e vault usano lo stesso AccessResolver, pur mantenendo servizi e corpora separati.

### 13.3 Broadcast

I resource event non possono più essere inviati indistintamente a tutti i client autenticati.

Il push contiene solo:

- revision;
- action;
- resource kind;
- resource id;
- summary autorizzata.

Nessun body, snippet, payload o tool output nel WebSocket push.

## 14. History unificata

### 14.1 Contratto

~~~text
GET /api/history
  ?kinds=chat,delegated_session,workflow_run,scheduled_run,event_delivery
  &status=running,failed
  &origin=...
  &parent_type=...
  &parent_id=...
  &from=...
  &to=...
  &include_children=false
  &limit=50
  &cursor=<opaque>
~~~

Risposta:

~~~json
{
  "items": [
    {
      "id": "activity-id",
      "kind": "chat",
      "resource_id": "session-id",
      "title": "Storage migration",
      "status": null,
      "origin": "desktop",
      "occurred_at": "2026-08-26T10:30:00Z",
      "parent": null,
      "session_id": "session-id",
      "live": false
    }
  ],
  "next_cursor": "opaque",
  "has_more": true,
  "revision": "history-revision"
}
~~~

### 14.2 Cursor

- occurred_at della singola activity version è immutabile;
- la prima pagina crea uno snapshot/query token scoped a principal con TTL;
- lo snapshot congela gli activity id e il loro ordine per quella navigazione;
- il cursor è opaque, validato e punta alla posizione nello snapshot;
- history_revision informa che esistono nuovi item ma non invalida le pagine già aperte;
- insert/update concorrenti non producono gap o duplicati dentro lo snapshot;
- filtro eseguito prima del LIMIT;
- risposta summary-only;
- prima pagina entro il budget payload.

Lo snapshot contiene soltanto id/order/revision, non transcript o snippet, e viene eliminato a TTL/logout. Se si decide di non mantenere snapshot server-side, il contratto deve dichiarare pagination eventually-consistent e il client deve deduplicare; non si può promettere entrambe le semantiche.

### 14.3 Causal grouping

Evitare duplicati:

- task_run con session_id produce una root scheduled run;
- event_delivery che avvia workflow/task/session produce una root event delivery;
- workflow AI step con child session resta dentro workflow run;
- delegated_session resta visibile come elemento di prima classe, nested/raggruppato sotto il parent quando presente;
- soltanto la child session causale già rappresentata da workflow run, scheduled run o event delivery non appare come chat top-level duplicata;
- i match restano navigabili nel figlio esatto tramite breadcrumb.

## 15. Ricerca globale API

### 15.1 Perché POST

Le query possono contenere testo sensibile. POST evita di inserirle in URL, proxy history e access log standard.

~~~text
POST /api/search
Content-Type: application/json
~~~

Request:

~~~json
{
  "query": "database locked",
  "scopes": ["chats", "tools", "workflows", "scheduled", "events"],
  "filters": {
    "status": ["failed"],
    "from": null,
    "to": null,
    "parent_id": null,
    "origin": null
  },
  "sort": "relevance",
  "limit": 40,
  "cursor": null
}
~~~

Response:

~~~json
{
  "items": [
    {
      "result_id": "stable-result-id",
      "root": {
        "kind": "workflow_run",
        "id": "run-id",
        "title": "Nightly backup",
        "status": "failed",
        "occurred_at": "2026-08-26T02:00:00Z"
      },
      "matches": [
        {
          "kind": "tool_result",
          "id": "tool-invocation-id",
          "field": "result",
          "author": "agent:openagent",
          "occurred_at": "2026-08-26T02:01:12Z",
          "fragments": [
            {"text": "sqlite returned ", "highlight": false},
            {"text": "database locked", "highlight": true}
          ],
          "sensitivity": "redacted",
          "completeness": "complete"
        }
      ],
      "match_count": 3,
      "target": {
        "kind": "workflow_run",
        "workflow_id": "workflow-id",
        "run_id": "run-id",
        "trace_step_id": "step-id",
        "tool_invocation_id": "tool-invocation-id"
      }
    }
  ],
  "next_cursor": "opaque",
  "index_generation": "generation",
  "indexed_seq": 12345,
  "coverage": {
    "complete": true,
    "lag_ms": 120,
    "per_corpus": {}
  },
  "query_mode": "keyword"
}
~~~

### 15.2 Cursor di ricerca

La prima pagina crea una search session scoped a tenant, principal, query, filtri e ACL version:

- conserva per TTL una lista bounded di root/doc id e score/order;
- non conserva body raw o secret;
- ogni pagina reidrata e ricontrolla ACL;
- un delete/revoke elimina il risultato anche se era nello snapshot;
- indexed_seq può avanzare senza invalidare la sessione;
- index_generation invalida soltanto su rebuild/schema/redaction incompatibile.

Il cursor contiene:

- search_session_id;
- posizione;
- query/filter hash;
- principal/ACL binding;
- index_generation;
- firma/HMAC locale.

Se generation, TTL o ACL rendono il cursor non riproducibile:

- HTTP 409;
- code cursor_stale;
- il client mantiene query/filtri e propone Refresh.

### 15.3 Snippet

- generato soltanto dopo ACL;
- massimo due passaggi per root;
- massimo circa 400 caratteri per passaggio;
- frammenti strutturati, mai HTML;
- escape sempre lato client;
- field, autore e timestamp espliciti;
- tool snippet mostra valori safe e placeholder redatti;
- nessun contesto raw attorno a un segreto.

### 15.4 Capability

GET /api/capabilities, autenticato:

~~~json
{
  "api_revision": 2,
  "features": {
    "history": {"version": 2},
    "global_search": {
      "version": 1,
      "scopes": ["chats", "tools", "workflows", "scheduled", "events"],
      "sorts": ["relevance", "recent"],
      "query_modes": ["keyword"],
      "tool_content": "redacted",
      "targets": [
        "chat",
        "chat_message",
        "chat_tool",
        "workflow_definition",
        "workflow_run",
        "scheduled_definition",
        "scheduled_run",
        "event_definition",
        "event_delivery"
      ],
      "snapshot_pagination": true,
      "max_page_size": 100
    },
    "session_messages": {
      "version": 1,
      "around": true,
      "bidirectional": true,
      "max_page_size": 100
    },
    "detail_resolvers": {
      "version": 1,
      "tool_invocation": true,
      "workflow_run": true,
      "scheduled_run": true,
      "event_delivery": true,
      "definition_field_anchors": false
    }
  },
  "storage": {
    "phase": "shadow",
    "schema_version": 2,
    "search_state": "ready",
    "search_ready": true,
    "index_generation": "generation-1",
    "indexed_seq": 12345
  }
}
~~~

Le versioni condivise del train sono `api_revision=2`, `history=2`,
`global_search=1`, `session_messages=1` e `detail_resolvers=1`. Il candidate
completo deve coprire esattamente i cinque scope e i nove target sopra; un
target non viene pubblicizzato prima che il relativo resolver autorizzato sia
implementato. Le capability possono essere incluse anche in auth_ok per evitare
una richiesta aggiuntiva, ma l'endpoint resta la fonte interrogabile.
`history.realtime_event` e `global_search.realtime_event` sono additivi e opzionali:
il client sottoscrive rispettivamente `history_changed` o `search_index_changed`
soltanto se annunciati. Il candidate iniziale non li pubblicizza finché il relativo
trasporto realtime autorizzato non è implementato e verificato; in loro assenza usa
refresh REST limitati.
Durante bootstrap/warm-up l'oggetto `features`, o le sue singole entry, può essere
assente. L'app e gli altri client long-lived usano l'eventuale
`storage.history_ready` per history e `storage.search_state`/`search_ready` per la
ricerca; su server senza `history_ready`, `search_state` resta il fallback di
bootstrap. Su un'installazione canonica v2 appena creata, `search_state=unavailable`
con FTS ancora assente è transitorio e viene trattato come warming finché il worker
crea l'indice. Mostrano warming e riprovano con backoff limitato; il CLI one-shot
restituisce l'exit/error retryable `warming` o `degraded`.
Nessun client interpreta una capability assente come zero risultati. Quando
`global_search=1` compare, espone l'intero contratto dei cinque scope e nove target,
non un sottoinsieme.

### 15.5 Enum e errori canonici

L'OpenAPI è la fonte di verità per le enum wire. Le fonti runtime/legacy con
vocabolari più ricchi vengono normalizzate secondo ADR-001 conservando sempre il
valore esatto in status_raw/raw envelope; complete per un messaggio, success per
un run e success/error per un tool non sono alias intercambiabili.

SearchScope:

- chats;
- tools;
- workflows;
- scheduled;
- events.

ActivityKind:

- chat;
- delegated_session;
- workflow_run;
- scheduled_run;
- event_delivery.

SearchRoot distingue definition e run senza cambiare la categoria UI. SearchMatch usa almeno title, description, prompt, message, tool_name, tool_args, tool_result, error e workflow_step.

Error body comune:

- unsupported;
- warming;
- degraded;
- cursor_stale;
- target_not_found;
- forbidden;
- offline è uno stato client, non un errore emesso da un server raggiungibile.

result_id è il root id per risultati raggruppati e l'invocation id nella vista Tools. Coverage e count riguardano soltanto il corpus autorizzato.

## 16. Endpoint dettaglio e deep-link

### 16.1 Messaggi

~~~text
GET /api/sessions/{id}/messages
  ?cursor=...
  &limit=100

GET /api/sessions/{id}/messages
  ?around=<message-id>
  &before=30
  &after=30
~~~

La seconda forma garantisce che un risultato vecchio sia incluso nella finestra renderizzata.

Response bidirezionale:

~~~json
{
  "messages": [],
  "anchor_found": true,
  "before_cursor": "opaque",
  "after_cursor": "opaque",
  "has_more_before": true,
  "has_more_after": true,
  "revision": "session-revision"
}
~~~

Il client mantiene range caricati e fa merge per message id/ordinal. anchor_found=false, deleted e forbidden sono stati espliciti. L'apertura con anchor non può avviare in parallelo il vecchio fetch della sola coda. Nuovi messaggi live aggiornano la tail ma mostrano New messages senza trascinare l'utente via da un anchor storico.

### 16.2 Tool

~~~text
GET /api/tool-invocations/{id}
~~~

Default:

- dettaglio user-visible;
- valori redatti secondo la stessa policy;
- artifact metadata autorizzata;
- raw non restituito senza capability separata.

### 16.3 Target tipizzati

| Match | Destinazione |
|---|---|
| Chat/session | `/chat?session=<id>` |
| Message | `/chat?session=<id>&message=<id>` |
| Tool in chat | `/chat?session=<id>&message=<id>&toolInvocation=<id>` |
| Workflow definition | `/workflows/<id>` |
| Workflow run | `/runs/<id>?kind=workflow&parentId=<id>` |
| Workflow step/tool | workflow run root; match-specific anchor è follow-up |
| Scheduled definition | `/tasks/<id>` |
| Scheduled run | `/runs/<id>?kind=task&parentId=<id>` |
| Scheduled transcript | run root; match-specific anchor è follow-up |
| Event definition | `/events/<id>` |
| Event delivery | `/runs/<id>?kind=event&parentId=<id>` |
| Event downstream run | vero workflow/task/chat target + breadcrumb della delivery causale |

SearchTarget viene fissato nella Fase 0 come discriminated union completa:

~~~ts
type SearchTarget =
  | { kind: 'chat'; sessionId: string }
  | { kind: 'chat_message'; sessionId: string; messageId: string }
  | {
      kind: 'chat_tool';
      sessionId: string;
      messageId: string;
      toolInvocationId: string;
    }
  | {
      kind: 'workflow_definition';
      workflowId: string;
      nodeId?: string;
      field?: string;
    }
  | {
      kind: 'workflow_run';
      runId: string;
      workflowId: string;
      traceStepId?: string;
      toolInvocationId?: string;
    }
  | {
      kind: 'scheduled_definition';
      taskId: string;
      field?: 'name' | 'prompt' | 'schedule';
    }
  | {
      kind: 'scheduled_run';
      runId: string;
      taskId: string;
      sessionId?: string;
      messageId?: string;
      toolInvocationId?: string;
    }
  | {
      kind: 'event_definition';
      eventId: string;
      field?: string;
    }
  | {
      kind: 'event_delivery';
      deliveryId: string;
      eventId: string;
      sessionId?: string;
      messageId?: string;
      toolInvocationId?: string;
    };
~~~

I campi opzionali `node_id`, `field`, `trace_step_id`, `message_id` e
`tool_invocation_id` mantengono la union estendibile, ma con
`definition_field_anchors=false` non sono una promessa dei risultati automation
della prima beta. Quando un futuro target usa `trace_step_id`, nel payload di
dettaglio ogni elemento di `trace_steps` espone invece l'anchor stabile
attempt-level nel campo `id`:
`node_id` non è un anchor e non si emettono alias `step_id` o
`trace_step_id` dentro `WorkflowTraceStep`. Il view model del client può
adattare questi nomi a `traceStepId`.

Per compatibilità wire, i detail esistenti di workflow run ed event delivery
mantengono `started_at` e `finished_at` numerici in epoch second e aggiungono campi
ISO (`started_at_iso`/`finished_at_iso`, con `occurred_at` come equivalente ISO
additivo di `started_at` per l'event delivery). La nuova route scheduled-run può
usare timestamp ISO canonici. Non si cambia mai il tipo primitivo di una chiave
esistente.

Contratti necessari:

- GET /api/scheduled-runs/{runId}, senza dipendere dagli ultimi 50 del parent;
- i resolver beta aprono la corretta root definition o l'esatto run/delivery per
  workflow, scheduled ed event;
- node/field, traceStepId e anchor automation annidati richiedono proiezione della
  provenienza del match e `definition_field_anchors=true` in un follow-up;
- toolInvocationId è distinto da tool_call_id;
- un evento che avvia un downstream workflow/task/chat apre il vero target e mostra breadcrumb Caused by event …;
- target cancellato/revocato mostra This result is no longer available e offre la root se ancora accessibile;
- nessun document kind viene indicizzato prima che esistano target resolver della
  root/run, fallback 404 e test di destinazione; gli anchor dettagliati non sono un
  gate finché la capability resta `false`.

## 17. Client: esperienza di ricerca

### 17.1 Entry point

Due ingressi:

1. una riga Search nella parte alta della sidebar;
2. Cmd/Ctrl+P globale, mantenendo compatibilità con lo switcher corrente.

Cmd/Ctrl+K resta il comando New session esistente e non diventa un alias della
ricerca nella prima beta.

La ricerca deve aprirsi da:

- Chat;
- Memory;
- Workflows;
- Scheduled;
- Events;
- Run detail;
- Settings e altre route autenticate.

### 17.2 Overlay

Riutilizzare la superficie esistente:

- stesso scrim;
- stesso glass surface;
- stessi colori, radius e blur;
- stessa posizione alta;
- max width circa 540;
- risultati fino a min(560px, 70vh);
- Modal nativa su mobile;
- nessuna nuova pagina.

Struttura:

1. input Search OpenAgent…;
2. categorie;
3. filtri;
4. lista risultati;
5. footer con shortcut.

Categorie:

- All;
- Chats;
- Tools;
- Workflows;
- Scheduled;
- Events;

Memory non entra nella prima beta operativa e non viene pubblicizzata nelle capability finché il relativo workstream di lifecycle/ACL non è pronto.

### 17.3 Query vuota

- riusare la prima pagina account-scoped dello history store soltanto con scope All
  e nessun filtro;
- questo riuso è un'ottimizzazione della sola prima pagina paginata, non un result
  set locale completo;
- nessuna seconda richiesta identica quando si apre l'overlay in quello stato;
- con uno scope specifico o qualunque filtro, usare POST /api/search con query vuota,
  scope espliciti (tutti e cinque per All filtrato), filtri normalizzati,
  sort=recent, grouping=match e cursor nullo;
- attività recente unificata;
- nessuna riga per ogni singolo messaggio/tool;
- cursor e infinite scroll;
- fallback legacy dichiarato se il server non supporta history v2.

Se l'utente seleziona Tools con query vuota, usare sempre POST /api/search con scope
tools, sort=recent e grouping=match. La tab Tools non pretende che /api/history
contenga tool invocation e mostra l'etichetta `Recent tools`.

### 17.4 Query non vuota

- POST /api/search;
- debounce iniziale 180 ms, da validare;
- AbortController sulla richiesta precedente;
- request generation monotonic;
- draftQuery separata da displayedQuery;
- Enter apre soltanto un risultato appartenente alla displayedQuery;
- risultati precedenti mantenuti durante refresh;
- spinner nell'input;
- nessuna persistenza locale della query nella prima versione;
- server-side ranking;
- load more con cursor;
- grouping deterministico nello snapshot.

La prima beta usa un unico ranking dell'indice operativo. Non applica RRF con vault/semantic. Se si introduce un soft cap fra categorie, l'algoritmo deve essere deterministico e materializzato nella search session.

### 17.5 Filtri

Prima versione:

- category/scope;
- status;
- periodo: any, 24h, 7d, 30d, custom;
- only errors;
- clear filters.

Status è disabilitato in Chats. Only errors è un preset dello stesso filtro status, non uno stato indipendente.

Non iniziare con:

- modello;
- provider;
- tag;
- sintassi query avanzata esposta.

### 17.6 Riga risultato

Mostra:

- icona categoria già esistente;
- titolo root;
- badge definition/run quando necessario;
- breadcrumb;
- snippet massimo due righe;
- highlight con colore e peso font;
- status;
- tempo relativo;
- match_count;
- indicazione partial/redacted quando applicabile.

La response porta matches con almeno i due passaggi migliori. Una affordance N more restringe una nuova query alla root; non si mostra un match_count irraggiungibile.

Esempi breadcrumb:

- Chat › assistant;
- Chat › filesystem.read_file;
- Workflow › Run 26 Aug › MCP node;
- Scheduled › Nightly backup › assistant;
- Event › GitHub push › Workflow step.

### 17.7 Apertura del risultato

Per message/tool:

- caricare una finestra around;
- includere sempre il target;
- scroll al centro;
- evidenziare temporaneamente;
- espandere ToolCard;
- spostare focus accessibile;
- sospendere auto-scroll verso il fondo;
- non alterare l'identità della nav history con anchor temporanee.

### 17.8 Stato client

Nuovo store search account-scoped:

- open;
- draftQuery;
- displayedQuery;
- scopes;
- filters;
- items;
- activeResultId;
- nextCursor;
- hasMore;
- loadingInitial;
- refreshing;
- loadingMore;
- pageError;
- offline;
- warming;
- degraded;
- historyRevision;
- indexGeneration;
- indexedSeq;
- coverage;
- requestId;
- needsRefresh;
- error.

Azioni:

- openSearch;
- closeSearch;
- setQuery;
- setScope;
- setFilters;
- search;
- loadMore;
- retry;
- invalidate;
- refresh;
- openResult;
- clearForAccount.

Montare l'overlay nella tabs layout, non dentro chat.tsx.

Il mount usa un portal/Modal cross-platform per non essere tagliato da Drawer o stacking context. La lista è virtualizzata. Il listener Cmd/Ctrl+P locale in chat.tsx viene rimosso per evitare doppia apertura.

Chiudere e riaprire l'overlay conserva in memoria query, filtri, lista e selezione per lo stesso account. Clear o account switch azzerano tutto. Non esiste persistenza su disco delle query nella prima versione.

### 17.9 Realtime

- history_changed arriva al commit canonico con ActivityItemSummary già autorizzata e permette upsert/delete senza perdere la selezione;
- search_index_changed arriva soltanto dopo che l'outbox è applicata e contiene indexGeneration/indexedSeq, non il body;
- query attiva: non riordinare mentre l'utente naviga;
- mostrare Results updated e consentire refresh;
- evento durante fetch: needsRefresh + trailing refresh;
- delete: rimuovere il risultato;
- logout/cambio account: abort, close e hard clear;
- nessun risultato stale cross-account.

### 17.10 Stati UX

- prima apertura: skeleton;
- pagination loading: spinner in fondo;
- errore iniziale: retry senza disabilitare input;
- errore pagina successiva: retry inline;
- empty history: No activity yet;
- no match: No results for …;
- filtri attivi senza match: Clear filters;
- offline con cache: saved results marcati offline;
- offline senza cache: Search requires a connection;
- server legacy: quick switcher chat esplicitamente limitato;
- index warming: indicazione di copertura, non falso zero.

Il fallback scatta soltanto su capability assente o unsupported/404 esplicito. Non scatta su 401, timeout o 5xx. Su server legacy:

- resta il quick switcher session-only;
- non viene rieseguito il fan-out automation da circa 124 richieste;
- Workflow/Scheduled/Events restano accessibili nelle rispettive sezioni;
- un messaggio discreto invita ad aggiornare il server per la ricerca completa.

### 17.11 Keyboard/accessibilità

- Esc chiude e ripristina il focus;
- frecce su/giù;
- Home/End;
- PageUp/PageDown;
- Enter apre;
- Tab/Shift+Tab resta nel dialog;
- ignore shortcut/Enter durante IME composition;
- active result sempre scrollato in vista;
- role dialog, aria-modal;
- input combobox;
- listbox/option;
- aria-activedescendant;
- live region polite;
- accessibilityViewIsModal su native;
- target touch 44×44;
- selected state non soltanto cromatico;
- reduced motion.

Nel pattern combobox il focus resta nell'input e la lista usa aria-activedescendant: le righe non diventano decine di tab stop. Esc chiude prima l'eventuale popover filtri e poi il dialog.

## 18. Client: history e sidebar

Sostituire activity.ts con uno store history:

- items;
- cursor;
- hasMore;
- loading/error;
- account generation;
- AbortController;
- trailing refresh;
- retry;
- filters;
- revision.

Regole:

- una richiesta dopo auth;
- nessun N+1;
- nessun cap nascosto a 50/60/200;
- delegated session visibile e raggruppata/nested sotto il parent;
- child causale di workflow/scheduled/event assorbita dalla root per evitare duplicati;
- summary live safe;
- load-more cursor;
- clear su logout/account switch;
- detail fetch soltanto all'apertura.

## 19. CLI

### 19.1 Client remoto

~~~text
openagent-cli history \
  --type chat,workflow_run \
  --status failed \
  --since 7d \
  --limit 50 \
  --cursor ... \
  --json

openagent-cli search "database locked" \
  --scope chats,tools,workflows \
  --status failed \
  --json

openagent-cli server-info --json
~~~

REPL:

- /history;
- /search;
- /sessions resta alias/fallback compatibile.

Il CLI non apre il DB del server: usa il gateway e rispetta lo stesso principal.

### 19.2 Storage admin sul server host

Soltanto nel binario/server CLI locale:

~~~text
openagent storage status --json
openagent storage verify [--full]
openagent storage backup
openagent storage migrate --plan
openagent storage migrate --apply
openagent storage migrate --resume
openagent storage rebuild-search
openagent storage restore --from <snapshot> --plan --offline
openagent storage restore --from <snapshot> --apply --offline
~~~

Backup/restore non vengono esposti via gateway finché non esiste authz admin realmente enforced.

Ogni comando documenta exit code e JSON schema stabili. history/search richiedono
--limit, --cursor e un --all esplicito per consumare tutte le pagine dello snapshot
accettato. `--all` non aggira TTL, quota per principal o massimo candidati: una query
troppo ampia fallisce esplicitamente come degraded/rate-limited e richiede filtri,
senza truncation silenziosa. Il fallback legacy avviene soltanto su capability
assente o unsupported/404, mai su 401, timeout o 5xx; la cache capability è scoped
per server e account.

### 19.3 Updater CLI

- self-update del CLI distinto da /update server;
- channel stable o beta;
- check-only;
- stable default;
- capability negotiation, non confronto rigido di versioni;
- checksum/firma;
- pre-swap selfcheck;
- sostituzione atomica;
- copia .old;
- boot guard;
- soppressione della bad version;
- regole SemVer prerelease esplicite.

Se questi requisiti non entrano nel primo release train, il self-update CLI viene rinviato: non si spedisce una variante meno sicura.

## 20. Migrazione

### 20.1 State machine

~~~text
legacy → shadow → prefer_v2 → v2
~~~

legacy:

- comportamento attuale;
- nessuna lettura v2.

shadow:

- schema v2 presente;
- legacy resta canonico;
- dual-write atomico nello stesso repository/transaction;
- backfill;
- read legacy;
- confronto shadow.

prefer_v2:

- lettura v2 quando complete;
- fallback per singola sessione;
- dual-write ancora attivo.

v2:

- v2 è fonte runtime;
- legacy continua a essere scritto per la finestra di rollback beta.

Fault injection interrompe la transazione fra ogni boundary logico per provare che blob, v2, activity, domain event e outbox non possano divergere parzialmente.

### 20.2 Snapshot obbligatorio

Prima della prima DDL:

- SQLite backup API o VACUUM INTO;
- checkpoint WAL controllato;
- mai copia raw del solo .db live;
- spazio libero preflight;
- manifest con server version, schema, byte, timestamp e SHA-256;
- permessi 0600;
- apertura della copia e PRAGMA integrity_check;
- restore rehearsal su una directory temporanea;
- journal sidecar della migration phase;
- fallire in sicurezza se il backup non è verificabile.

Gli artifact migrati restano copy-only fino alla fine della finestra di rollback.

### 20.3 Backfill

- newest-first;
- keyset su updated_at + session_id;
- batch piccoli;
- idempotente;
- resumable;
- checkpoint per sessione;
- parser di JSON normale, double-encoded e malformato;
- ID deterministici;
- recurse member responses;
- dedup tool per id;
- timestamp normalization;
- author inference marcata;
- completeness marcata quando il legacy era già compacted/truncated;
- nessuna invenzione di contenuto mancante.

Ogni estrazione registra source_version/hash e usa conditional upsert/CAS. Se la fonte cambia prima del commit, il lavoro viene scartato e rimesso in coda; un backfill vecchio non può sovrascrivere un dual-write nuovo.

### 20.4 Shadow verification

Per ogni sessione:

- run count/order/hash;
- message count/order/hash;
- author;
- tool id/name/status/args/result hash;
- attachment/artifact;
- child link;
- status;
- timestamps;
- visible reasoning;
- ACL/owner.

La lettura v2 non si attiva su una sessione incompleta.

### 20.5 Rollback

Rollback normale:

- feature flag storage phase torna a legacy;
- lo stesso binary beta continua a dual-scrivere e può tornare a leggere sessions.runs;
- nessuna restore;
- nessuna perdita dei turni nuovi perché il dual-write resta attivo.

Downgrade a binary pre-v2:

- quel binary scrive soltanto sessions.runs e non mantiene v2;
- i trigger legacy_session_changes registrano create/update/delete anche dal vecchio binary;
- last_writer_version/epoch aiuta quando il writer lo supporta ma non è l'unico segnale;
- al boot si confrontano inoltre set di session id e gating hash/version per intercettare drift o trigger mancanti;
- al re-upgrade il server torna automaticamente in shadow;
- create, update, delete e retention avvenuti durante il downgrade vengono riconciliati prima di prefer_v2;
- la prima beta installabile deve introdurre il protocollo dual-write/epoch prima di consentire prefer_v2;
- test obbligatorio: downgrade, create/update/delete, re-upgrade, reconcile.

Restore snapshot:

- solo offline;
- solo per corruzione catastrofica;
- conferma forte;
- warning esplicito sulle scritture successive allo snapshot.

### 20.6 Rimozione legacy

Non durante questa beta.

Condizioni minime:

- almeno un ciclo beta completo;
- almeno una stable con v2 attivo;
- backup e restore provati;
- compatibilità vecchi client scaduta;
- nessun mismatch;
- consenso esplicito a una migrazione distruttiva separata.

## 21. Retention e full fidelity

Default target:

- sessioni conservate finché l'utente non le cancella;
- messaggi e tool history non eliminati dalla compaction;
- reasoning visibile conservato;
- artifact retention esplicita e mostrata;
- pin/legal hold prevale;
- event raw payload può avere TTL separato, ma non il downstream transcript;
- delete fonte crea tombstone immediato nell'indice;
- artifact eliminato soltanto con ref_count zero;
- indice è cancellabile e ricostruibile.

Interventi:

- disattivare il default distruttivo 3 giorni/5 run;
- unificare i path retention divergenti;
- trasformare compaction in context snapshot;
- rendere le policy configurabili e visibili;
- non promettere full fidelity se completeness segnala un legacy già potato.

## 22. Search agent-side

Il tool search_past_conversations e la UI non devono avere due definizioni differenti di storia.

Target:

- SearchService unico;
- stesso extractor;
- stesso AccessResolver;
- stesso coverage;
- stesso redaction layer;
- scope esplicito chats, tools, workflows, scheduled ed events;
- vault continua attraverso il proprio servizio/corpus separato finché il workstream Memory non è pronto;
- risultato agent-side con source/evidence class;
- nessuna fusione silenziosa tra nota curata e transcript;
- principal server-injected;
- semantic opzionale soltanto su body_safe e con egress dichiarato.

Il vecchio transcript_index resta ponte durante shadow, poi viene sostituito dall'indice operativo.

## 23. Memory vault: interventi separati

Non modificare la fonte Markdown.

Da pianificare nello stesso programma, ma come workstream distinto:

- unificare lifecycle e health del vault index;
- sincronizzare modifiche esterne prima della ricerca o tramite watcher/outbox file;
- evitare due istanze non coordinate sullo stesso index file;
- correggere il custom vault path end-to-end;
- allineare il Node scanner search_notes e il Python FTS;
- namespace del meta schema;
- rebuild con DROP delle sole tabelle possedute;
- validazione collisione dei path;
- coverage/freshness visibili.

Ricerca globale:

- Memory sarà uno scope futuro separato, non incluso nelle capability della prima beta;
- ogni hit è marcato vault_note;
- la vista history non include note;
- la vista All potrà includerle soltanto dopo una decisione UX esplicita.

## 24. Miglioramenti grafici

Workstream successivo alla foundation di dati, sullo stesso branch:

- font display: SF Pro Display, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif;
- font body/navigation: stack di sistema;
- mono per codice e shortcut;
- rimozione del caricamento runtime dei Google font;
- nessun riferimento al progetto da cui deriva la scelta tipografica;
- rimozione uppercase/tracking forzati dai button;
- riduzione di rail cyan decorativi non necessari;
- stato attivo sidebar statico e più sobrio;
- wordmark/logo meno decorativi;
- riduzione del clock/logo dominante nel login;
- preservare colori, blur e layout generale;
- rispettare reduced motion;
- screenshot regression dark/light e tutte le viewport.

## 25. Realtime

Commit canonico:

- aggiorna fonte;
- aggiorna activity_items;
- scrive search_outbox;
- incrementa historyRevision.

Index worker:

- applica outbox;
- mantiene indexGeneration e avanza indexedSeq;
- pubblica solo invalidation safe;
- misura lag.

Eventi distinti:

- history_changed viene emesso dopo il commit canonico e porta action, historyRevision e una ActivityItemSummary autorizzata per quel destinatario;
- search_index_changed viene emesso soltanto quando indexedSeq ha raggiunto l'outbox commit e porta indexGeneration/indexedSeq;
- il primo non causa un refresh prematuro dell'FTS;
- il secondo non invalida cursor della stessa indexGeneration.

Client:

- history vuota può fare upsert summary;
- ricerca attiva mantiene selection;
- trailing refresh se l'evento arriva in-flight;
- cursor stale viene gestito esplicitamente;
- delete immediato;
- account switch cancella tutto.

## 26. Osservabilità e privacy

Telemetria locale di default:

- migration phase;
- righe/byte/durata;
- batch time;
- lock wait;
- retry;
- WAL size;
- query latency;
- scope;
- result count;
- query length bucket;
- coverage;
- index lag;
- rebuild state;
- error class.

Non registrare:

- query;
- snippet;
- title;
- handle;
- path;
- payload;
- tool args/result;
- token;
- secret;
- hash della query.

Export remoto soltanto opt-in e già redatto.

Health autenticato:

- storage phase;
- schema version;
- search ready/warming/degraded;
- outbox lag;
- coverage;
- last index error;
- last verified backup.

## 27. Piano per repository

### 27.1 openagent-server

- schema migrations;
- backup/preflight;
- SessionRepository;
- schema v2;
- dual-write;
- backfill/shadow compare;
- artifact store;
- context snapshots;
- retention;
- AccessResolver/ACL;
- activity projection;
- history API;
- search outbox/indexer;
- redaction/extractors;
- SearchService;
- search/capabilities/messages/tool detail API;
- realtime filtrato;
- memory-search adapter;
- storage CLI;
- updater beta;
- test e benchmark.

### 27.2 openagent-app

- capability types;
- API history/search/messages;
- cancellation signal;
- history store;
- search store;
- global overlay;
- sidebar entry;
- category/filter UI;
- cursor;
- coverage states;
- typed targets;
- message/tool anchor e root/run automation;
- realtime trailing refresh;
- account clear;
- accessibility;
- font/visual cleanup;
- test store/API;
- Playwright/Electron E2E;
- beta updater/feed.

### 27.3 openagent-cli

- capabilities;
- history/search commands;
- REPL commands;
- cursor/JSON;
- fallback legacy;
- server-info;
- installazione manuale prerelease; self-update rinviato finché non soddisfa
  tutti i gate;
- test suite;
- cross-version integration.

### 27.4 openagent-docs

- ADR storage;
- DDL/schema reference;
- API contract;
- privacy/redaction policy;
- migration operator guide;
- backup/restore guide;
- beta channel guide;
- search UX guide;
- changelog soltanto quando esiste una release.

## 28. Fasi di implementazione

### Fase 0 — contratto e baseline

Deliverable:

- questo piano;
- ADR SQLite-first;
- DDL v2;
- OpenAPI/schema delle response;
- corpus di ranking;
- fixture legacy;
- benchmark baseline;
- threat model search.

Exit:

- decisioni aperte risolte;
- nessun codice runtime ancora attivato;
- nessuna release.

### Fase 1 — migration foundation

Deliverable:

- schema_migrations;
- backup verificato;
- migration state;
- repository;
- schema v2;
- artifact primitives;
- ACL primitives;
- flag legacy/shadow.

Exit:

- DB fresh e legacy migrano;
- kill/resume;
- rollback legacy;
- zero dati persi.

### Fase 2 — normalized shadow

Deliverable:

- dual-write;
- backfill;
- shadow compare;
- context snapshots;
- retention corretta;
- normalized detail API dietro flag.

Exit:

- parità 100% sulle fixture;
- completeness esplicita;
- write O(nuovo contenuto);
- nessun lock regressivo.

### Fase 3 — history

Deliverable:

- activity_items;
- GET /api/history;
- cursor;
- realtime revision;
- app history store/sidebar;
- CLI history.

Exit:

- una richiesta sidebar;
- oltre 200 sessioni;
- nessun N+1;
- pagination stabile;
- fallback client legacy.

### Fase 4 — global search server

Deliverable:

- search_outbox;
- operational search index;
- extractor/redaction;
- SearchService;
- POST /api/search;
- coverage;
- agent/CLI integration;
- rebuild command.

Exit:

- tutti i corpora previsti;
- secret scan pulito;
- ACL prima di candidate limit, snippet, count restituito e serializzazione;
- deep target stabile;
- performance gate.

### Fase 5 — global search client

Deliverable:

- overlay globale;
- categories/filters;
- pagination;
- deep links;
- around-message;
- tool auto-expand;
- workflow run resolution; step anchor rinviato;
- accessibility;
- offline/error/warming states.

Exit:

- ogni scenario E2E passa due volte;
- keyboard e screen reader;
- nessun stale cross-account;
- screenshot regression accettata.

### Fase 6 — visual cleanup

Deliverable:

- font;
- rimozione decorazioni superflue;
- login/sidebar/button/card cleanup;
- reduced motion.

Exit:

- colori/blur/layout invariati;
- dark/light;
- 800×600, 1280×800, mobile;
- visual diff approvato.

### Fase 7 — dogfood e hardening

Deliverable:

- copie di DB reali;
- benchmark multipiattaforma;
- build dry-run;
- compatibility matrix;
- updater channel test;
- backup/restore drill.

Exit:

- tutti i gate;
- nessun stop condition;
- approvazione manuale per release.

### Fase 8 — prerelease beta autorizzata ma gated

L'autorizzazione al train è registrata; soltanto dopo l'evidenza richiesta dal
runbook:

- server beta additive;
- app/CLI con capability fallback;
- GitHub prerelease beta.1;
- dogfood opt-in;
- beta.2 con prefer_v2;
- eventuale RC soltanto con una decisione successiva.

Stable e rimozione legacy richiedono autorizzazioni separate e non fanno parte
di questa fase.

## 29. Gate di correttezza

- 100% session/run/message order parity per ogni record parseable e dichiarato complete;
- 100% author parity per ogni record complete;
- 100% tool invocation identity parity per ogni record complete;
- tutti gli inferred/partial/corrupt sono contati e non vengono mai promossi a complete;
- artifact/link parity;
- nessun ghost hit dopo delete;
- nessun match cross-owner;
- compaction non elimina storia;
- child session lineage preservata;
- event/workflow/task causal grouping corretto;
- query in italiano, inglese e Unicode;
- quote, phrase e prefix supportati dal parser pubblico;
- malformed/double JSON;
- legacy compacted/truncated dichiarato;
- cursor tamper/stale;
- index rebuild/corruption;
- FTS assente produce degraded esplicito;
- server locale raggiungibile funziona senza Internet; server spento produce correttamente lo stato offline del client.

## 30. Gate di performance iniziali

Hardware di riferimento e dataset devono essere registrati accanto ai risultati.

| Area | Gate iniziale |
|---|---|
| History | 50 item su 100k: p95 warm ≤200 ms, cold ≤500 ms |
| Search | 1M message/tool docs: p95 warm ≤300 ms, cold ≤1 s |
| Client perceived | primo risultato p95 ≤600 ms dall'ultimo tasto su rete locale, incluso debounce |
| Index freshness | steady-state ≤1–2 s |
| Sidebar | contenuto visibile ≤1 s, una fetch |
| Payload | prima pagina ≤256 KiB |
| Write scaling | turn 10.000 ≤2× costo turn 10 a payload uguale |
| Lock | zero lost/duplicate, zero lock error surfaced o retry exhausted; lock transitori restano interni |
| Migration | batch commit p99 ≤100 ms |
| Foreground regression | ≤20% durante backfill |
| Pagination | zero gap/duplicati con insert concorrenti |

Dataset:

- empty/fresh;
- legacy piccolo;
- double-encoded;
- record corrotto;
- blob da 4 MB;
- 10k e 100k sessioni;
- 1M messaggi;
- tool output grandi;
- workflow con loop/retry;
- event che lancia workflow/task/chat;
- APFS, ext4, NTFS;
- gateway, scheduler, workflow, event e MCP concorrenti.

## 31. Test E2E della ricerca

1. Aprire la ricerca da ogni route principale.
2. Query vuota: una history request.
3. Digitazione rapida: soltanto l'ultima response può vincere.
4. Cercare testo in una chat mai aperta.
5. Aprire e centrare il messaggio esatto.
6. Cercare tool name.
7. Cercare valore non sensibile negli args.
8. Cercare testo redatto-safe nel result.
9. Aprire ToolCard già espansa.
10. Cercare prompt di workflow.
11. Cercare errore in workflow step.
12. Cercare output scheduled.
13. Cercare downstream transcript di un event.
14. Verificare che raw event payload non compaia senza allowlist.
15. Verificare che un secret piantato non compaia in API, DB search, snippet, telemetry o embedding request.
16. Load more oltre 100 risultati.
17. Delete/revoke durante search.
18. Resource event durante request.
19. Logout/account switch durante request.
20. Offline, warming, degraded, retry.
21. Keyboard-only e IME.
22. Screen reader.
23. Screenshot dark/light e viewport.
24. Agent search e UI restituiscono la stessa evidenza autorizzata.
25. Scheduled run più vecchio dei 50 attuali.
26. Due attempt dello stesso workflow node aprono lo stesso run corretto; gli anchor
    attempt-level distinti diventano gate soltanto con
    `definition_field_anchors=true`.
27. Stesso tool_call_id in due context diversi.
28. Target cancellato o ACL revocata fra response e click.
29. Query/filter/account cambiano mentre loadMore è in volo.
30. Riapertura overlay conserva query e selezione in-memory.
31. Commit canonico compare prima in history e poi, dopo indexedSeq, in search.
32. Anchor storico resta fermo mentre arrivano nuovi messaggi.
33. Highlight con emoji, combining mark e testo bidi.
34. Snippet con Markdown/HTML ostile.
35. Capability parziali: history senza search e search senza around.

## 32. Compatibility matrix

- old app → new server;
- old CLI → new server;
- new app → old server;
- new CLI → old server;
- new clients → new server legacy;
- new clients → new server shadow;
- new clients → prefer_v2;
- restart durante ogni migration phase;
- rebuild indice;
- stable non vede beta;
- beta.1 → beta.2;
- beta → stable più nuova;
- checksum errato;
- download interrotto;
- asset mancante;
- boot guard/rollback binario.

Le versioni server, app e CLI restano indipendenti. La compatibilità è per capability e API revision.

## 33. Canale beta

L'autorizzazione beta è registrata, ma tag e pubblicazione restano subordinati
ai gate e non risultano eseguiti:

- tag vX.Y.Z-beta.N;
- GitHub Release prerelease=true;
- make_latest=false;
- stable default;
- nessun auto-enroll;
- il server packaged/frozen usa stable di default e continua a ignorare
  prerelease; l'opt-in beta è installation-scoped tramite config o
  `OPENAGENT_UPDATE_CHANNEL=beta`, con feed, lineage, asset, checksum e
  bad-version guard separati;
- Friday parte da `0.19.x`: poiché il selector beta non attraversa una
  major/minor verso una prerelease, `0.20.0-beta.1` viene installato una sola
  volta manualmente dal package Linux x64 verificato per checksum e digest;
  soltanto dopo il seed il feed beta gestisce la linea `0.20`;
- Friday usa un drop-in systemd dedicato con
  `OPENAGENT_UPDATE_CHANNEL=beta` soltanto dopo backup/preflight; il rollback
  rimuove o ripristina quel drop-in e verifica il processo riavviato, mentre un
  eventuale `auto_update.channel` confliggente blocca il rollout;
- installare esplicitamente un'app `-beta.N` costituisce l'opt-in; quella build
  usa channel beta e `allowPrerelease`, mentre una build stable resta su latest;
- il recovery manuale dell'app usa l'installer stable pubblicato `v0.16.0`,
  verificando digest e firma di piattaforma effettivamente disponibili prima
  del downgrade; non si assume un installer o una firma non verificata;
- feed beta separati per OS;
- validazione tag/version;
- test, build e pubblicazione sono job ordinati dello stesso workflow
  tag-triggered; una futura candidate/promotion split resta hardening;
- release app esegue test.sh;
- CLI esegue la suite unittest e resta a installazione manuale;
- release train manifest registra i tre SHA esatti.

Pubblicazione immutabile con il workflow corrente:

1. preflight, test E2E disponibili e Friday baseline/backup rehearsal si
   chiudono prima del tag server;
2. il push dell'esatto tag beta è la prima mutazione pubblica e avvia il
   workflow sullo SHA congelato;
3. i job testano, costruiscono e firmano una volta, poi eseguono lo smoke sul
   package finale prima del suo upload come workflow artifact;
4. il release job scarica e verifica l'unione esatta degli artifact, crea un
   draft GitHub non pubblicato e con overwrite disabilitato;
5. mentre `draft=true`, confronta attraverso l'API autenticata nomi, size e
   digest `sha256:` di ogni asset con i byte locali;
6. solo dopo il confronto porta il draft a `draft=false`,
   `prerelease=true`, `make_latest=false` e ricontrolla lo stato pubblicato;
7. il server package pubblicato viene installato su Friday col digest esatto e
   sottoposto a E2E, rollback `0.19.x` e re-upgrade; app e CLI vengono
   pubblicati soltanto dopo questo gate;
8. l'indice finale di evidenza contiene SHA, versioni API/capability, workflow
   run ID, attestazioni e digest locali/GitHub degli artifact.

Un test su build locale o su byte ricostruiti non soddisfa il gate. Un fallimento
di upload/verifica lascia la release nascosta; tag e versione vengono
abbandonati a favore di un nuovo `beta.N`, mai riutilizzati.

Updater gate:

- stable non vede mai prerelease;
- beta è soltanto opt-in;
- beta può avanzare verso una stable semanticamente più nuova;
- nessun downgrade ambiguo;
- checksum/firma e bad-version guard restano obbligatori.

Stop immediato se:

- mismatch dati;
- leak cross-user;
- scrittura persa;
- lock non gestito;
- backup/restore non provato;
- prerelease visibile al canale stable;
- ricerca dichiara complete quando è parziale;
- deep-link apre il contenuto sbagliato.

## 34. Decisioni ancora aperte

1. Memory/vault nella tab All?
   - Decisione beta iniziale: no; workstream e capability separati.
2. I risultati Workflow/Scheduled/Event devono distinguere visivamente definition e run?
   - Raccomandazione: stessa categoria, badge distinto.
3. Quanto testo di tool output grande indicizzare?
   - Raccomandazione: chunk completo entro budget configurato, partial esplicito oltre il budget; benchmark prima di fissare il default.
4. Consentire una modalità privileged raw-tool search?
   - Raccomandazione: non nella prima beta.
5. Semantic search nel client?
   - Raccomandazione: keyword prima; semantic opt-in dopo ACL e safe-body migration.
6. Shortcut della ricerca globale?
   - Decisione beta: Cmd/Ctrl+P; Cmd/Ctrl+K resta New session per evitare una regressione del comando esistente.
7. Activity projection materializzata o UNION ALL?
   - Raccomandazione: activity_items transazionale e ricostruibile; misurare entrambi nel benchmark.
8. Soglia per introdurre PostgreSQL?
   - Raccomandazione: definire da SLO dopo normalizzazione, non anticiparla.

## 35. Prossimi artefatti di pianificazione

Creati e collegati nel pacchetto di specifica:

1. i tre ADR;
2. DDL canonica e DDL dell'indice ricostruibile;
3. OpenAPI e tipi wire TypeScript;
4. threat model;
5. specifica dell'overlay e del refresh visuale sul layout esistente;
6. piano di verifica cross-repository;
7. runbook del canale beta e della pubblicazione prerelease gated.

Restano da produrre o automatizzare prima del rollout:

1. fixture generator deterministico e benchmark harness eseguibile;
2. diagramma entità/relazioni generato dalla DDL;
3. mock frozen OpenAPI per prototipare e testare il client senza server runtime;
4. report baseline prestazionale sui corpus definiti dal piano di verifica;
5. matrice di review con owner e sign-off per storage, sicurezza, API, UX e release.

## 36. Stato del lavoro

Completato come specifica/audit (non come prova dei gate di rilascio):

- audit storage server;
- audit history/sidebar app;
- audit transcript/vault/semantic index;
- confronto SQLite/MongoDB;
- audit release/updater;
- worktree isolati;
- ADR storage, storia canonica e indice operativo;
- DDL canonica v2 e DDL FTS operativa v1;
- OpenAPI e SearchTarget TypeScript;
- threat model, specifica visuale, piano di verifica e runbook beta;
- questo piano consolidato.

Implementato nei worktree beta, senza dichiarazione di gate end-to-end superati:

- base server aggiornata a stable `v0.19.26`; il rebase finale e la ripetizione
  dei gate restano richiesti prima del freeze; versioni Beta 1 fissate a server
  `0.20.0-beta.1`, app `0.17.0-beta.1`, CLI `0.16.0-beta.1`;
- storage v2, migrazione/dual-write/reconcile/backfill, proiezione automazioni e
  indice FTS redatto e separato sul server;
- capability/history/search a cinque scope e nove target, inclusi resolver detail;
- client app per history/sidebar/search/deep-link e CLI remoto per
  capability/history/search;
- isolamento prerelease negli updater supportati;
- package smoke nativi, asset-set verifier, attestazioni e pubblicazione tramite
  draft nascosto verificato per digest nei tre workflow;
- suite unit/contract/package aggiunte nei workstream runtime, ancora da
  raccogliere nel bundle di evidenza cross-repository.

Allineamento contratto verificato sui worktree correnti:

- OpenAPI, `api/search-target.ts`, server, app e CLI condividono esattamente i
  cinque activity kind, i cinque search scope e i nove `SearchTarget.kind`;
- il gateway registra gli otto endpoint documentati per capability, history,
  search, message window e quattro detail resolver; la query testuale usa
  esclusivamente il body di `POST /api/search`;
- il server emette `api_revision=2`, `history=2`, `global_search=1`,
  `session_messages=1`, `detail_resolvers=1`, con
  `definition_field_anchors=false`; app e CLI richiedono il set completo prima
  di usare search v1;
- `features` resta presente ma può essere vuoto durante bootstrap; lo storage
  espone `history_ready`, `history_pending`, `search_state` e `search_ready`, e i
  client ritentano senza trasformare warming/degraded in risultati vuoti;
- il server non pubblicizza ancora eventi realtime. Gli schema WebSocket restano
  riservati e i client usano refresh REST limitato;
- i resolver workflow/event conservano campi legacy additivi oltre al core
  normalizzato; l'OpenAPI li consente e i client ignorano membri sconosciuti;
- i target automation possono contenere anchor opzionali, ma finché
  `definition_field_anchors=false` il gate garantisce soltanto definition root,
  run o delivery corretti.

Non completato o non ancora verificato end-to-end:

- prova live di migrazione, backup, restore e downgrade su fixture rappresentative;
- canary ACL/API gateway-only, bridge filter e benchmark Friday;
- realtime history/search, che resta opzionale e non pubblicizzato;
- matrice UI/deep-link multipiattaforma, QA visuale e test E2E con server reale;
- dogfood Friday/Bluehost con principal temporaneo e rollback;
- tag;
- push;
- prerelease pubblicate e verifica post-publish che stable `latest` sia invariata.
