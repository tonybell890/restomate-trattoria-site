# Osteria Angolo Masuccio - sample booking site

A fake restaurant website used to test the Restomate public booking API from a browser. It is a static HTML/CSS/JS page (no build step, no external dependencies) served by a minimal ASP.NET Core host.

The page lets a guest choose the party size, pick a day on a calendar, see the available time slots, enter contact details, and confirm. It calls only the **public** endpoints, so it never needs an API key.

## Run it

1. In the Restomate dashboard, open the restaurant "Osteria Angolo Masuccio" and copy its ID (tab **Integrazione API**). Make sure it is active and has tables and opening hours.
2. Put the ID in `wwwroot/config.json` (`restaurantId`), or open the site with `?restaurant=<id>` appended to the address. If Restomate does not run on `https://localhost:7145`, change `apiBase` or add `?api=<origin>`.
3. Start Restomate (`dotnet run --project src/Restomate.Web --launch-profile https`). Restart it after pulling these changes: the slots endpoint and CORS settings are new.
4. Start this site (`dotnet run --project samples/TrattoriaDaMario --launch-profile https`) and open https://localhost:7300. In Visual Studio you can set both projects as startup projects.

If the browser shows "Impossibile contattare il servizio", check that Restomate is running, that the development certificate is trusted (`dotnet dev-certs https --trust`), and that the site origin is listed under `Cors:AllowedOrigins` in `src/Restomate.Web/appsettings.Development.json` (already contains `https://localhost:7300` and `http://localhost:5300`).

## What it calls

| Purpose | Request |
|---|---|
| Name, time zone, first and last bookable day | `GET /api/v1/restaurants/{id}` |
| Available start times for a day and party size | `GET /api/v1/restaurants/{id}/availability/slots?date=YYYY-MM-DD&partySize=N` |
| Confirm a booking | `POST /api/v1/restaurants/{id}/reservations` with an `Idempotency-Key` header |

Times shown on the page are in the restaurant's time zone. The booking request sends the chosen slot as a UTC instant. A booking uses one fresh idempotency key; it is reused only when the same request is retried after a network failure.

## Notes

- The calendar uses the restaurant's "today" and last bookable day returned by the API, not the browser clock.
- Slots are advisory. If someone else takes the table first, the confirmation returns `no_availability` and the page reloads the slots.
- The public booking endpoint is open to anyone who knows the restaurant ID, protected by rate limiting only. A production site should add bot protection (for example a captcha) or have its own server call the API. Never put a management key in this page.
- The JavaScript has no automated tests; it was proofread but not executed in a browser by the author.
