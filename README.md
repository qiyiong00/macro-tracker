# Macro Tracker

A personal calorie and macro tracker that installs on an iPhone home screen. It has no server and no account. Your food log is stored on your phone.

- **Today:** calories, protein, carbs and fat against your daily targets
- **AI Chat:** describe a meal or send a photo, and Claude estimates the macros and logs them
- **History:** past days and a 7-day average
- **Settings:** a target calculator, the AI key, and backup/restore

## Install on iPhone

1. Open the app's GitHub Pages link in **Safari** (it has to be Safari).
2. Tap **Share**, then **Add to Home Screen**.
3. Open it from the home screen icon. It works offline, except for the AI chat.

## Turn on the AI chat

1. Create an API key at <https://console.anthropic.com> and add a few dollars of credit.
2. In the app, go to **Settings → AI chat**, paste the key and tap **Save**.

The key is stored only on your phone. It isn't in this code and isn't included in backups. Settings shows an estimate of this month's AI spend. Switch the model to Haiku there to cut costs a lot.

## Back up your data

Your log is stored only in Safari's storage on your phone. From time to time, go to **Settings → Export backup** and save the file to Files or iCloud Drive. Use **Import backup** to restore it.

## Update the app

Edit the files on the laptop, then run:

```
git add -A
git commit -m "Describe the change"
git push
```

GitHub Pages redeploys in about a minute. The phone picks up the new version the next time the app is opened with an internet connection.
