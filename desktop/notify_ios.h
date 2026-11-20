// Local notifications on iOS (notify_ios.m, for notify_ios.go).

// Installs the notification centre's delegate (banners while the app is
// open; a tap calls back with the notification's id).
void bnInit(void);
// 1 allowed, 0 refused, 2 not asked yet.
int bnAuthorization(void);
// Shows the system prompt (the first time); 1 when allowed.
int bnRequest(void);
// Shows a notification now; the same id replaces an earlier one.
void bnPost(const char *ident, const char *title, const char *body, int silent);
void bnRemove(const char *ident);
