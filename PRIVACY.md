# Data and privacy / Daten und Datenschutz

## English

App: Vorwerk Kobold VR200/VR300. Developer: Lindner IT Solutions. This describes this app's handling of data, not the separate services operated by Vorwerk or Athom.

The app connects Homey to the robot through Vorwerk's cloud. During sign-in, your email and one-time code are sent over HTTPS to Vorwerk's MyKobold authentication service and held temporarily for the pairing session. They are not saved in app/device storage. No account password is requested.

Homey stores the robot serial, device secret, cloud endpoint, saved map names/identifiers and chosen cleaning area privately with the device. The account ID token and optional refresh token are also stored there to read history/maps and renew access. Homey backups may contain these credentials. Expired or rejected access can require signing in through Repair. No separate developer account is created and credentials are not sent to the developer.

Depending on the robot's supported features, the app reads state, battery, device/battery information, saved schedule, cleaning areas, history and map metadata. Map images can reveal a floor plan. In app settings, the selected saved-map image loads automatically when you open the History and maps section; this section is open by default. A cleaning image loads when its individual entry is expanded. Images for all 20 history entries are not preloaded in the background. The UI temporarily caches at most one saved-map image and one cleaning image per robot. Signed image URLs remain private in app memory for at most 15 minutes; they are not given to the UI or persisted. Images are not saved in the device store. The cloud retains its own records independently.

Homey capabilities and Flows receive displayed status/cleaning values. Configured Homey Insights may retain capability history according to Homey's settings. This app's device API excludes credentials, account identifiers, serials and raw cloud image URLs. Images use known opaque identifiers, not arbitrary URLs.

There is no separate analytics, advertising or developer telemetry service. Support diagnostics are off by default. If explicitly enabled, they retain a bounded state/command summary, counts and image origins; area diagnostics can include an area name. They exclude credentials, serials, coordinates, full cloud responses and signed image URLs. Logs contain generic failures rather than cloud response bodies.

Remove the robot from Homey to remove its saved device credentials and selection. Uninstalling the app also removes app settings. Existing backups follow your Homey retention: deleting current data does not erase old backup copies or Vorwerk cloud history. An app restart discards temporary image/history caches. Manage cloud records through MyKobold and the respective service's controls.

Homey needs internet access to the fixed Vorwerk endpoints in README.md. Transport to the Homey UI follows your Homey configuration. The app does not publish your cleaning history or floor plan to a public website.

Support and bug reports use the project's [public GitHub issue tracker](https://github.com/SornyKonst/Homey-App-Vorwerk-Kobold/issues). Anything you submit there is public. Include the app/Homey versions, robot model and a description of the problem; do not post email codes, tokens, robot secrets, serial numbers or identifying floor-plan images. The app does not send reports there automatically.

## Deutsch

App: Vorwerk Kobold VR200/VR300. Entwickler: Lindner IT Solutions. Diese Angaben beschreiben diese App, nicht die eigenständigen Dienste von Vorwerk oder Athom.

Die App verbindet Homey über die Vorwerk-Cloud mit dem Roboter. Bei der Anmeldung werden E-Mail-Adresse und Einmalcode per HTTPS an die MyKobold-Anmeldung von Vorwerk gesendet und während des Anmeldedialogs vorübergehend gehalten. Sie werden nicht dauerhaft in App- oder Gerätespeicher abgelegt. Ein Kontopasswort wird nicht abgefragt.

Homey speichert Seriennummer, Gerätegeheimnis, Cloud-Endpunkt, gespeicherte Kartennamen/-kennungen und die gewählte Reinigungsfläche geschützt beim Gerät. Dort liegen auch Konto-ID-Token und ein gegebenenfalls gelieferter Refresh-Token, um Verlauf und Karten auszulesen und den Zugang zu erneuern. Homey-Backups können diese Zugangsdaten enthalten. Abgelaufener oder widerrufener Zugang kann eine neue Anmeldung über „Reparieren“ erfordern. Es wird kein gesondertes Entwicklerkonto angelegt; Zugangsdaten werden nicht an den Entwickler gesendet.

Je nach den unterstützten Funktionen des Roboters liest die App Zustand, Akku, Geräte-/Batterieinformationen, gespeicherten Zeitplan, Bereiche, Verlauf und Kartenangaben. Kartenbilder können einen Grundriss zeigen. In den App-Einstellungen lädt das Bild der gewählten gespeicherten Karte automatisch beim Öffnen von Verlauf und Karten; dieser Abschnitt ist standardmäßig geöffnet. Das Bild einer Reinigung lädt beim Aufklappen ihres einzelnen Eintrags. Die Bilder aller 20 Verlaufseinträge werden nicht im Hintergrund vorgeladen. Die Oberfläche hält vorübergehend höchstens das Bild einer gespeicherten Karte und ein Reinigungsbild je Roboter im Zwischenspeicher. Signierte Bildadressen bleiben höchstens 15 Minuten im privaten Arbeitsspeicher der App; sie werden weder an die Oberfläche ausgegeben noch dauerhaft gespeichert. Bilder liegen nicht im Gerätespeicher. Die Cloud bewahrt ihre eigenen Daten unabhängig auf.

Homey-Anzeigen und Flows erhalten die angezeigten Zustands-/Reinigungswerte. Homey Insights kann Messwertverläufe gemäß den Homey-Einstellungen aufbewahren. Die Geräte-API dieser App gibt keine Zugangsdaten, Kontokennungen, Seriennummern oder ursprünglichen Cloud-Bildadressen aus. Bilder verwenden nur bekannte, undurchsichtige Kennungen, keine beliebigen Internetadressen.

Es gibt keinen eigenen Analyse-, Werbe- oder Entwickler-Telemetriedienst. Support-Diagnosen sind standardmäßig ausgeschaltet. Ausdrücklich aktiviert halten sie eine begrenzte Zustands-/Befehlszusammenfassung, Anzahlen und Bildserver-Herkünfte fest; Bereichsdiagnosen können einen Bereichsnamen enthalten. Zugangsdaten, Seriennummern, Koordinaten, vollständige Cloud-Antworten und signierte Bildadressen sind ausgeschlossen. Protokolle enthalten allgemeine Fehler statt Cloud-Antwortinhalten.

Entferne den Roboter aus Homey, um seine gespeicherten Verbindungsdaten und Auswahl zu löschen. Die Deinstallation entfernt auch die App-Einstellungen. Für vorhandene Backups gilt deine Homey-Aufbewahrung: Das Löschen aktueller Daten löscht weder alte Sicherungskopien noch Vorwerks Cloud-Verlauf. Ein App-Neustart verwirft vorübergehende Bild-/Verlaufsdaten. Cloud-Daten verwaltest du über MyKobold und die Funktionen des jeweiligen Dienstes.

Homey benötigt Internetzugang zu den festen Vorwerk-Endpunkten in README.md. Die Verbindung zur Homey-Oberfläche folgt deiner Homey-Konfiguration. Diese App veröffentlicht deinen Reinigungsverlauf oder Grundriss nicht auf einer öffentlichen Website.

Support und Fehlermeldungen laufen über den [öffentlichen GitHub-Issue-Tracker des Projekts](https://github.com/SornyKonst/Homey-App-Vorwerk-Kobold/issues). Dort eingestellte Inhalte sind öffentlich. Nenne App-/Homey-Version, Robotermodell und eine Problembeschreibung; veröffentliche keine E-Mail-Codes, Token, Gerätegeheimnisse, Seriennummern oder identifizierenden Grundrissbilder. Die App sendet dorthin keine automatischen Berichte.
