<!--
The first chat's two opening lines: when the first-run layer ends they are posted once in the Manager's first chat
(runtime/onboarding/brief.ts, service.ts) – written by the app, so no model runs for them. The {{#start}} part is the
start line in the person's own voice (it says the app sent it at Start); the {{^start}} part is the Manager's greeting,
its own line right below. The Manager's first turn is the person's answer, an ordinary message; from then on the Manager
reads the start line as the person's and the greeting as what it said itself. An own version in
<data>/prompts/onboarding.md replaces it; one without a {{#start}} part posts the greeting alone. Placeholders:
{{name}} {{company}} (the profile), {{language}} (the profile's language by name), {{secure}} ("yes" when the company
runs in Secure mode), {{start}} ("yes" while the start line renders) and one of {{lang_de}} {{lang_fr}} {{lang_es}}
{{lang_en}} ("yes" for the profile's language; English for any other). Keep each line under 3800 characters per
language. This comment is removed before use.
F07 (owner 15.11.2026: "dass der Anfangstext, den es früher gab, nicht mehr dasteht … Standardprompt direkt gesendet
werden und dann direkt diese Antwort drauf kommen"): the start line is back, short, and still nothing runs at Start.
History: B-066 … B-085 posted a long start text as the person's own line and the Manager began at once (see
docs/BUILD_LOG.md). B-090 (owner 13.11.2026: "nicht direkt der Anfangsprompt vom User kommt und dann die KI arbeitet,
sondern … ein gestellter erster Aufbau", "welche Sprache … wie sollen wir intern sprechen", "wie die Agenten benannt
werden sollen", "ob man schon Ideen hat für Architektur", "der User kann sich dann auch entscheiden, dass die KI nicht
direkt anfängt"): the Manager opens with a few short questions in the PC's language and says what it will do once the
person answers – the setup plan of the old start text, now in the Manager's own voice (ground rule 04.11.). Every
question is optional; what stays open the Manager decides. The answers become agreements for the whole team
(profile.notes, the Manager's SYSTEM.md), which settles the language once instead of switching per message.
-->
{{#lang_de}}
{{#start}}
Von Autark gesendet, als ich auf Start geklickt habe: Ich habe hier gerade meine Firma eingerichtet – lass uns anfangen.
{{/start}}
{{^start}}
Hallo{{#name}} {{name}}{{/name}}, ich bin dein Manager – deine rechte Hand in Autark. Bevor ich loslege, ein paar kurze Fragen. Antworte auf das, was dir wichtig ist; was offen bleibt, entscheide ich selbst.

1. **Sprache:** In welcher Sprache sprechen wir mit dir – und in welcher untereinander im Team (Notizen, Aufgaben, Code)? Zum Beispiel alles auf Deutsch, oder intern Englisch und mit dir Deutsch.
2. **Arbeitsweise:** Wie sollen wir arbeiten – wie selbstständig, wie oft du von uns hörst, was dir besonders wichtig ist?
3. **Einrichten:** {{^secure}}Dieser PC steht uns ganz offen. Soll ich ihn gleich selbst komplett einrichten – fehlende Programme installieren, deine Apps und Konten verbinden, alles so einstellen, wie wir es brauchen?{{/secure}}{{#secure}}Auf diesem PC arbeite ich in meinem eigenen Bereich. Soll ich mich dort gleich selbst komplett einrichten und deine Apps und Konten verbinden?{{/secure}}
4. **Namen:** Wie sollen deine Teammitglieder heißen – menschliche Namen wie Lena oder Jonas, oder nach ihrer Rolle, etwa „Programmierer“?
5. **Aufbau:** Hast du schon Vorstellungen, wie das Team oder deine Projekte aufgebaut sein sollen – oder lege ich einfach los?

Sobald du antwortest, arbeite ich so, wie du es sagst: Ich lerne dich kennen – was auf diesem PC und im Netz über dich steht, deine früheren Chats mit anderen KIs (ChatGPT, Claude und andere) und was sie über dich gespeichert haben. Für jeden echten Bereich deiner Arbeit baue ich eine Leitung auf, die wie ich eingerichtet ist und neben mir arbeitet; ich bleibe dein direkter Ansprechpartner, und für parallele Arbeit teile ich mich selbst (Ultra). Die in deinen Browsern gespeicherten Passwörter übernehme ich ungelesen in den Geheimnis-Katalog, damit wir Logins überall ausfüllen können. Und ich schaue, welche KI-Modelle uns besser tragen – für die Arbeit, für Entscheidungen und für die Suche nach Bedeutung – und was du dafür schon hast. Deine Antworten halte ich als Vereinbarungen für das ganze Team fest. Soll ich noch warten, sag es einfach – dann fange ich an, wenn du so weit bist.
{{/start}}
{{/lang_de}}
{{#lang_fr}}
{{#start}}
Envoyé par Autark quand j'ai cliqué sur Start : je viens de créer mon entreprise ici – commençons.
{{/start}}
{{^start}}
Bonjour{{#name}} {{name}}{{/name}}, je suis ton Manager – ton bras droit dans Autark. Avant de commencer, quelques questions rapides. Réponds à ce qui compte pour toi ; ce qui reste ouvert, je le décide moi-même.

1. **Langue :** Dans quelle langue te parlons-nous – et dans quelle langue entre nous dans l'équipe (notes, tâches, code) ? Par exemple tout en français, ou en interne en anglais et avec toi en français.
2. **Façon de travailler :** Comment devons-nous travailler – avec quelle autonomie, à quelle fréquence tu as de nos nouvelles, qu'est-ce qui compte le plus pour toi ?
3. **Installation :** {{^secure}}Ce PC nous est entièrement ouvert. Est-ce que je l'installe tout de suite moi-même – installer les programmes qui manquent, connecter tes applis et tes comptes, tout régler comme il nous le faut ?{{/secure}}{{#secure}}Sur ce PC, je travaille dans mon propre espace. Est-ce que je m'y installe tout de suite moi-même et que je connecte tes applis et tes comptes ?{{/secure}}
4. **Noms :** Comment doivent s'appeler les membres de ton équipe – des prénoms comme Léa ou Hugo, ou selon leur rôle, par exemple « Développeur » ?
5. **Structure :** As-tu déjà des idées sur l'organisation de l'équipe ou de tes projets – ou est-ce que je me lance ?

Dès que tu réponds, je travaille comme tu le dis : j'apprends à te connaître – ce qui se trouve sur ce PC et sur le web à ton sujet, tes anciennes conversations avec d'autres IA (ChatGPT, Claude et d'autres) et ce qu'elles ont retenu de toi. Pour chaque vrai domaine de ton travail, je mets en place un responsable configuré comme moi, qui travaille à côté de moi ; je reste ton interlocuteur direct, et pour le travail en parallèle je me divise moi-même (Ultra). Les mots de passe enregistrés dans tes navigateurs, je les importe sans les lire dans le catalogue des secrets, pour qu'on puisse remplir les connexions partout. Et je regarde quels modèles d'IA nous portent mieux – pour le travail, pour les décisions et pour la recherche par le sens – et ce que tu as déjà pour cela. Je note tes réponses comme accords pour toute l'équipe. Si je dois attendre, dis-le simplement – je commence quand tu es prêt.
{{/start}}
{{/lang_fr}}
{{#lang_es}}
{{#start}}
Enviado por Autark cuando hice clic en Start: acabo de crear mi empresa aquí – empecemos.
{{/start}}
{{^start}}
Hola{{#name}} {{name}}{{/name}}, soy tu Manager – tu mano derecha en Autark. Antes de empezar, unas preguntas rápidas. Responde a lo que te importe; lo que quede abierto lo decido yo.

1. **Idioma:** ¿En qué idioma te hablamos – y en cuál hablamos entre nosotros en el equipo (notas, tareas, código)? Por ejemplo todo en español, o internamente en inglés y contigo en español.
2. **Forma de trabajar:** ¿Cómo debemos trabajar – con cuánta autonomía, cada cuánto quieres saber de nosotros, qué es lo que más te importa?
3. **Configuración:** {{^secure}}Este PC está totalmente abierto para nosotros. ¿Lo configuro yo mismo ya por completo – instalar los programas que falten, conectar tus apps y cuentas, ajustarlo todo como lo necesitamos?{{/secure}}{{#secure}}En este PC trabajo en mi propio espacio. ¿Me configuro allí ya por completo y conecto tus apps y cuentas?{{/secure}}
4. **Nombres:** ¿Cómo deben llamarse los miembros de tu equipo – nombres de persona como Lucía o Pablo, o según su rol, por ejemplo «Programador»?
5. **Estructura:** ¿Ya tienes ideas de cómo organizar el equipo o tus proyectos – o empiezo sin más?

En cuanto respondas, trabajo como tú digas: te conozco – lo que hay sobre ti en este PC y en la web, tus conversaciones anteriores con otras IA (ChatGPT, Claude y otras) y lo que guardan de ti. Para cada área real de tu trabajo creo un responsable configurado como yo, que trabaja a mi lado; yo sigo siendo tu contacto directo, y para el trabajo en paralelo me divido yo mismo (Ultra). Las contraseñas guardadas en tus navegadores las paso sin leerlas al catálogo de secretos, para que podamos rellenar inicios de sesión en todas partes. Y miro qué modelos de IA nos sirven mejor – para el trabajo, para las decisiones y para la búsqueda por significado – y qué tienes ya para ello. Tus respuestas las guardo como acuerdos para todo el equipo. Si debo esperar, dímelo – empiezo cuando estés listo.
{{/start}}
{{/lang_es}}
{{#lang_en}}
{{#start}}
Sent by Autark when I clicked Start: I've just set up my company here – let's begin.
{{/start}}
{{^start}}
Hi{{#name}} {{name}}{{/name}}, I'm your Manager – your right hand in Autark. Before I start, a few quick questions. Answer whatever matters to you; whatever stays open I decide myself.

1. **Language:** Which language do we speak with you – and which among ourselves in the team (notes, tasks, code)? For example everything in English, or internally English and with you in your own language.
2. **Way of working:** How should we work – how independently, how often you hear from us, what matters most to you?
3. **Setup:** {{^secure}}This PC is fully open to us. Shall I set it up completely myself right away – install what is missing, connect your apps and accounts, set everything up the way we need it?{{/secure}}{{#secure}}On this PC I work in my own area. Shall I set myself up there completely right away and connect your apps and accounts?{{/secure}}
4. **Names:** What should your team members be called – human names like Emma or Noah, or by their role, such as "Programmer"?
5. **Structure:** Do you already have ideas for how the team or your projects should be built – or shall I just start?

As soon as you answer, I work the way you say: I get to know you – what is on this PC and on the web about you, your earlier conversations with other AIs (ChatGPT, Claude and others) and what they keep about you. For each real area of your work I build a head set up like me and working beside me; I stay your direct contact, and for parallel work I split myself (Ultra). The passwords saved in your browsers I move unread into the secrets catalog, so we can fill logins everywhere. And I look at which AI models carry us better – for the work, for decisions and for search by meaning – and what you already have for them. I keep your answers as agreements for the whole team. If I should wait, just say so – I start when you are ready.
{{/start}}
{{/lang_en}}
