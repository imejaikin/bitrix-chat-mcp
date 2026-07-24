# Зеркало истории чатов Bitrix24 для точного поиска.
# Дополняет bitrix24-local-mcp: там — живое состояние и запись, здесь — память.
# Пишущих операций здесь нет намеренно.

install:   ## поставить зависимости
	npm install

sync:      ## докачать новые сообщения выбранных чатов (инкрементально)
	node src/sync.mjs

status:    ## что в зеркале: чаты, объём, свежесть
	node src/status.mjs

ui:        ## локальная страница настройки (только 127.0.0.1)
	node src/ui.mjs

serve:     ## MCP-сервер (stdio)
	node src/server.mjs

help:
	@grep -E '^[a-z-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "};{printf "  %-10s %s\n", $$1, $$2}'

.PHONY: install sync status ui serve help
