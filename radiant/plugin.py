from bdh_sdk import PluginSpec, Tile

spec = PluginSpec(
    id="radiant",
    app="radiant",
    urls="radiant.urls",
    status="radiant.homepage.status",
    tiles=(
        Tile(
            title="Radiant Heat",
            url_name="radiant",
            icon="radiant/hub/icon.svg",
            section="lodge",
            subtitle="Floor heating by zone",
            order=40,
        ),
    ),
)
