# vulu api

vulu Launcher'ın, [vuluvulu.com.tr](https://vuluvulu.com.tr) sitesinin ve vulu Server Panel'in kullandığı sunucu. Hesaplar ve katılma istekleri, profiller, vulu Packs, ekran görüntüleri, uçtan uca şifreli mesajlar ve oyun içi kimlik doğrulama (authlib-injector) buradadır.

Node.js, Express ve MongoDB ile yazılmıştır. Canlıda `https://vuluvulu.com.tr/api` adresinde çalışır.

## Lisans

[AGPL-3.0](LICENSE). Kodu özgürce kullanabilir, değiştirebilir ve dağıtabilirsiniz. Değiştirilmiş bir sürümü dağıtan ya da sunucuda çalıştırıp başkalarına sunan, kaynak kodunu da aynı lisansla açmalı ve bu projenin telif ve lisans bildirimlerini korumalıdır.

"vulu" adı ve VL logosu lisansa dahil değildir: kendi sürümünüzü dağıtırken farklı bir ad ve logo kullanın.

Kullanılan üçüncü taraf bileşenler ve lisansları: [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Push bildirimleri (vulu Sosyal)

Telefon uygulaması girişten sonra Firebase Cloud Messaging token'ını `POST /users/me/devices` ile kaydeder, çıkışta
`DELETE /users/me/devices/:token` ile siler. Onay bekleyen yeni bir kayıt isteği aktif adminlerin telefonlarına
bildirim olur; bir admin onaylayınca ya da reddedince öbürlerinin bildirimi kalkar. Adminler `PUT /users/me/notifications
{ registrations: false }` ile kapatabilir.

Göndermek için `.env`'e Firebase projesinin servis hesabı eklenir (Firebase Console → Proje ayarları → Hizmet hesapları →
Yeni özel anahtar oluştur):

```
FCM_SERVICE_ACCOUNT_FILE=/etc/vulu/firebase-service-account.json
```

ya da JSON'un kendisi tek satır olarak `FCM_SERVICE_ACCOUNT=...`. Tanımlı değilse push gönderilmez, API normal çalışır.
