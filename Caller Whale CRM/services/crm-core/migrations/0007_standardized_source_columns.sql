-- Keep a stable, queryable interpretation beside each original uploaded row.
-- Original cells remain authoritative and are never rewritten by this column.
ALTER TABLE importing.rows ADD COLUMN source_data jsonb NOT NULL DEFAULT '{}';

CREATE FUNCTION importing.property_details(data jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'beds', CASE WHEN data->>'bedrooms' ~ '^[0-9]+([.][0-9]+)?$' THEN (data->>'bedrooms')::numeric END,
    'baths', CASE WHEN data->>'bathrooms' ~ '^[0-9]+([.][0-9]+)?$' THEN (data->>'bathrooms')::numeric END,
    'area', CASE WHEN replace(data->>'living_area', ',', '') ~ '^[0-9]+([.][0-9]+)?$' THEN replace(data->>'living_area', ',', '')::numeric END,
    'county', data->>'county',
    'year_built', data->>'year_built',
    'lot_acres', data->>'lot_size_acres',
    'lot_square_feet', data->>'lot_size_square_feet',
    'land_use', data->>'land_use',
    'property_type', data->>'property_type',
    'property_use', data->>'property_use',
    'subdivision', data->>'subdivision',
    'legal_description', data->>'legal_description',
    'units', data->>'units',
    'stories', data->>'stories',
    'garage_type', data->>'garage_type',
    'garage_area', data->>'garage_area',
    'carport', data->>'carport',
    'carport_area', data->>'carport_area',
    'cooling', data->>'cooling',
    'heating', data->>'heating',
    'fireplaces', data->>'fireplaces',
    'owner_occupied', data->>'owner_occupied',
    'vacancy', data->>'vacancy'
  ))
$$;
