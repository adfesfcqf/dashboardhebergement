# scripts/open-firewall-windows.ps1
#
# Ajoute une règle de pare-feu Windows autorisant les connexions entrantes
# vers le port du dashboard. Sur Windows, le pare-feu bloque par défaut
# les connexions entrantes non sollicitées vers un port ouvert par une
# appli comme Node — c'est très souvent CA qui empêche d'accéder au
# dashboard depuis un autre appareil/l'extérieur, même quand le code
# écoute déjà correctement sur toutes les interfaces (0.0.0.0).
#
# À LANCER EN POWERSHELL "ADMINISTRATEUR" (clic droit > Exécuter en tant
# qu'administrateur), sinon New-NetFirewallRule échoue avec un accès refusé.
#
# Usage :
#   .\scripts\open-firewall-windows.ps1
#   .\scripts\open-firewall-windows.ps1 -Port 3000

param(
  [int]$Port = 3000
)

$ruleName = "Dashboard (port $Port)"

if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
  Write-Host "Une règle '$ruleName' existe déjà, rien à faire." -ForegroundColor Yellow
} else {
  New-NetFirewallRule `
    -DisplayName $ruleName `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort $Port `
    -Action Allow | Out-Null
  Write-Host "✅ Règle de pare-feu créée : connexions entrantes autorisées sur le port $Port/TCP." -ForegroundColor Green
}

Write-Host ""
Write-Host "Rappel : ça n'ouvre l'accès que sur CE PC. Pour que quelqu'un depuis" -ForegroundColor Cyan
Write-Host "l'extérieur de ton réseau local puisse s'y connecter, la box internet" -ForegroundColor Cyan
Write-Host "doit aussi rediriger le port vers ce PC (voir scripts/open-dashboard-access.js" -ForegroundColor Cyan
Write-Host "pour le faire automatiquement via UPnP, si ta box le supporte)." -ForegroundColor Cyan