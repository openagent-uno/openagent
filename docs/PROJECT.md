# OpenAgent: mappa e contesto operativo

Audit locale: **2 novembre 2026**. Le versioni e i risultati di produzione nelle
ricevute sono storici; non sono stati ricontrollati in rete durante questo audit.

## Agnosticità obbligatoria

OpenAgent non deve contenere riferimenti a progetti o client esterni che lo
includono, né feature o bug fix specifici per un consumer. Il difetto si riduce
a un contratto generico, corretto upstream e riutilizzabile da ogni host conforme.
Dati, branding, policy e adapter di dominio rimangono fuori da OpenAgent.
La regola vale per tutti i suoi repository: [agnosticità](AGNOSTICISM.md),
[mappa componenti](COMPONENTS.md), [uso](USAGE.md).

## Proprietà e repository

La workspace ha tre repository attivi con versionamento indipendente:
`openagent` assembla il prodotto; `openagent-core` è la libreria embedded;
`openagent-tools` fornisce gli strumenti autonomi. Usare
[workspace.py](../scripts/workspace.py) per i componenti del prodotto e
[la transizione dei repository](repository-transition.md) per gli executor legacy.

La documentazione canonica e la visione sono in [docs/site](site/index.md) e
[site/vision.md](site/vision.md). `openagent-docs` e il vecchio repository
`openagent-mcp` sono stati rimossi il 2 novembre 2026 dopo backup verificati.
I repository App/CLI/server/host-tools precedenti conservano distribuzioni e
ponti updater; non sono la destinazione di nuove feature. Non cancellarne release, firme o asset
necessari agli aggiornamenti installati.

## Lettura per attività

| Attività | Fonte |
| --- | --- |
| Confini Core/Tools/prodotto | [Architettura](architecture-v1.md), [moduli](modules-v1.1.md) |
| UI e servizi componibili | [Application composition](site/guide/application-composition.md) |
| Contratti di client e computer | [Client capabilities](site/guide/client-capabilities.md), [copertura nativa](native-capability-coverage.md) |
| Canali | [Channels](site/guide/channels.md), [embedding](site/guide/embedded-channels.md) |
| Connector e OAuth | [Operazioni](site/guide/connector-operations.md), [stato](site/guide/connector-status.md) |
| Build, aggiornamenti e release | [Build/release](build-and-release.md), [qualificazione](runtime-and-verification.md) |
| Storico delle consegne | [Indice precedente](INDEX-HISTORY-2026-11-02.md), `releases/`, `qualification/` |

## Riconciliazione delle memorie

Le note che richiedono sviluppo coordinato nei vecchi repository separati sono
superate dalla transizione canonica. Le vecchie istruzioni di patching del server
embedded sono superate dalla regola upstream sottostante. Non confondere la
presenza di un tool nel catalogo con disponibilità, autorizzazione o acceptance
del provider. La visione multi-canale non dimostra la qualifica live di tutti i canali.

Le correzioni recenti di client/MCP Apps e bridge desktop hanno anche modifiche
locali non committate: conservare il lavoro concorrente e usare le singole
ricevute, senza dichiarare automaticamente pubblicati gli ultimi sorgenti.
Il [ripristino Vault Telegram](qualification/vault-telegram-2026-10-27.json)
è una prova datata, non un motivo per rigenerare identità o azzerare un vault.

## Materiale privato

Non includere directory personali di agenti, database, credenziali di modelli o
connector nei documenti o nei bundle. Per custodia e configurazione consultare
[privacy](site/privacy.md) e [config reference](site/guide/config-reference.md);
questo indice non introduce un nuovo deposito di segreti.

## Sviluppo agentico: OpenAgent è il proprietario

**Decisione esplicita dell'utente, 2 novembre 2026.** Ogni nuova funzione o
correzione della parte agentica deve essere implementata nel componente OpenAgent
che la possiede: tools, channels, runner, loop di esecuzione, sessioni, memoria,
discovery, scheduling, delega e contratti delle capabilities. Il prodotto consumer
eredita la capacità attraverso API/SDK pubblici e dipendenze versionate.

La regola vale **anche quando l'architettura OpenAgent corrente è incompleta o
sbagliata**: correggere prima il contratto e l'implementazione upstream. Non
aggirarla con patch locali, monkey patch, override, fork embedded, overlay di
pacchetti, copie di tool/runner o mutazioni del sorgente durante build/installazione.
Una patch già presente nel repository è debito da ricondurre upstream, non un
precedente che autorizza nuove patch. Questo audit documentale non certifica che
tutte le integrazioni esistenti siano già conformi.

| Responsabilità | Dove intervenire |
| --- | --- |
| Engine, sessioni/run, memoria, scheduler, delega, framework e contratti pubblici | `OpenAgent/openagent-core` |
| Tools riutilizzabili, browser/computer, SDK/adapter condivisi dei connector | `OpenAgent/openagent-tools` |
| Distribuzione standalone, App/CLI/server, bridge e integrazioni di prodotto OpenAgent | `OpenAgent/openagent` |
| Identità e autorizzazione del dominio, dati del prodotto, lifecycle dell'infrastruttura e UI consumer | Nel prodotto, come integrazione dei contratti pubblici |

Un adapter di dominio può collegare dati e permessi del prodotto; non deve
reimplementare il comportamento agentico. Se manca un punto di estensione,
aggiungerlo a OpenAgent e provarne l'uso da un consumer.

Percorso di consegna: riprodurre il difetto al confine pubblico; aggiungere la
regressione nel componente upstream; implementare la capacità condivisa;
qualificare e versionare la dipendenza; aggiornare il pin del consumer; provare
il percorso reale dal client al runtime. Distinguere sempre test upstream,
integrazione consumer, artefatto firmato e acceptance live. Un aggiornamento
documentale non autorizza da solo release, migrazioni o deploy.

## Manutenzione e provenienza

L'audit del 2 novembre 2026 ha inventariato e analizzato automaticamente il testo
delle memorie locali Codex (archivi corrente e v2) e Claude, poi confrontato le
indicazioni rilevanti con istruzioni, codice, manifest e manuali del progetto.
La riconciliazione semantica è mirata ai vincoli e ai conflitti operativi; non è
una nuova verifica di ogni feature o di ogni ambiente remoto.

Ordine di lettura: richiesta corrente dell'utente, istruzioni applicabili,
contratti e codice della checkout, documentazione mantenuta, evidenze datate,
memorie storiche. Una visione definisce l'obiettivo; non dimostra che sia già
implementato. Se codice e regola architetturale divergono, registrare il debito
e correggere il proprietario appropriato, senza trasformare il difetto in norma.

Aggiornare il capitolo che possiede l'argomento nello stesso cambiamento. Gli
indici restano brevi; risultati temporanei e versioni vanno nei checkpoint con
data, fonte e livello di verifica. Le vecchie ricevute restano prove storiche,
non istruzioni di esecuzione. Non copiare trascrizioni grezze, credenziali,
cookie, chiavi, dati personali o inventari domestici dalle memorie nei manuali.
Documentare solo percorsi e procedure di accesso al deposito privato già previsto.
