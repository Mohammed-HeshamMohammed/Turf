"""Which CRM field each source column is, from its header. The wording is the same as the CRM's own column matching
(desktop/frontend/react/src/field-vocabulary.ts): phrases are compared after case, punctuation and spacing are evened out,
so "Owner Name", "OWNER_NAME" and "ownerName" read the same. A column it does not know is suggested as "not used"."""
import re

# CRM field -> what people call it. Phones and emails may come from several columns (phone 1, phone 2).
VOCABULARY = {
    "name": ["name", "full name", "owner", "owner name", "owner full name", "primary owner", "owner 1", "customer", "customer name", "client",
             "client name", "contact", "contact name", "seller", "seller name", "homeowner", "home owner", "lead name", "person", "person name",
             "taxpayer", "taxpayer name", "deed holder", "grantee", "recipient", "full owner name"],
    "first_name": ["first name", "first", "fname", "given name", "forename", "owner first name", "owner 1 first name", "first name owner",
                   "customer first name", "client first name", "contact first name", "seller first name"],
    "last_name": ["last name", "last", "lname", "surname", "family name", "owner last name", "owner 1 last name", "last name owner",
                  "customer last name", "client last name", "contact last name", "seller last name"],
    "phone": ["phone", "phone number", "phone 1", "phone #", "alt phone", "alternate phone", "alternative phone", "telephone", "tel", "mobile", "mobile phone", "mobile number", "cell", "cell phone",
              "cellphone", "wireless", "landline", "contact number", "contact phone", "owner phone", "primary phone", "best phone", "home phone",
              "work phone", "number", "whatsapp"],
    "email": ["email", "e mail", "email address", "owner email", "contact email", "primary email"],
    "address": ["address", "street address", "property address", "site address", "situs address", "address 1", "address line 1", "street",
                "location", "house address", "home address", "subject property address", "property street"],
    "unit": ["unit", "apartment", "apt", "suite", "address 2", "address line 2", "unit number"],
    "city": ["city", "town", "property city", "site city", "situs city"],
    "region": ["state", "region", "province", "property state", "site state", "state code"],
    "zip": ["zip", "zip code", "zipcode", "postal code", "postcode", "property zip", "site zip"],
    "country": ["country", "nation"],
    "latitude": ["latitude", "lat", "y"],
    "longitude": ["longitude", "long", "lng", "lon", "x"],
    "parcel": ["apn", "parcel", "parcel id", "parcel number", "pin", "folio", "tax id"],
    "value": ["value", "estimated value", "est value", "market value", "property value", "price", "avm", "estimated price", "assessed value",
              "total assessed value"],
    "source": ["source", "lead source", "list source", "origin"],
}
MULTIPLE = {"phone", "email"}
_MAILING = {"mailing", "mail"}  # the mailing address is another address than the property's: not matched to the property fields

_lookup = {phrase: field for field, phrases in VOCABULARY.items() for phrase in phrases}

# Recognized headings whose values remain in the original PostgreSQL source rows.
# They are not offered as lead fields until the Core schema and merge support them.
SOURCE_DETAILS = {
    "id": "Source record ID", "county": "County", "living square feet": "Living area", "year built": "Year built",
    "lot acres": "Lot size (acres)", "lot square feet": "Lot size (square feet)", "land use": "Land use",
    "property type": "Property type", "property use": "Property use", "subdivision": "Subdivision",
    "legal description": "Legal description", "units count": "Units", "bedrooms": "Bedrooms", "bathrooms": "Bathrooms",
    "# of stories": "Stories", "garage type": "Garage type", "garage square feet": "Garage area",
    "carport": "Carport", "carport area": "Carport area", "air conditioning type": "Cooling",
    "heating type": "Heating", "# of fireplaces": "Fireplaces",
    "owner mailing address": "Owner mailing address", "owner mailing city": "Owner mailing city",
    "owner mailing state": "Owner mailing state", "owner mailing zip": "Owner mailing ZIP",
    "ownership length months": "Ownership length", "owner type": "Owner type",
    "owner occupied": "Owner occupied", "vacant": "Vacancy",
    "batch name": "Batch name", "original file name": "Original file name", "upload date": "Upload date",
    "status": "Status", "original status": "Original status", "status time": "Status time",
    "status agent": "Status agent", "lead file campaign": "Lead file campaign",
}
SOURCE_DETAILS.update({
    "record id": "Source record ID", "property id": "Source record ID", "lead id": "Source record ID",
    "parish": "County", "living sq ft": "Living area", "living area": "Living area",
    "building square feet": "Living area", "building area": "Living area", "square footage": "Living area",
    "beds": "Bedrooms", "bedroom count": "Bedrooms", "baths": "Bathrooms", "bathroom count": "Bathrooms",
    "lot size acres": "Lot size (acres)", "acreage": "Lot size (acres)",
    "lot sq ft": "Lot size (square feet)", "lot sqft": "Lot size (square feet)",
    "number of stories": "Stories", "stories": "Stories", "# stories": "Stories",
    "garage area": "Garage area", "carport square feet": "Carport area",
    "cooling": "Cooling", "air conditioning": "Cooling", "heating": "Heating",
    "fireplaces": "Fireplaces", "number of fireplaces": "Fireplaces",
    "mailing address": "Owner mailing address", "mailing city": "Owner mailing city",
    "mailing state": "Owner mailing state", "mailing zip": "Owner mailing ZIP",
    "vacant": "Vacancy", "vacancy": "Vacancy", "is vacant": "Vacancy",
    "owner occupancy": "Owner occupied", "ownership type": "Owner type",
    "months owned": "Ownership length", "ownership length": "Ownership length",
})


def normalize_header(header: str) -> str:
    """Lower-case words separated by single spaces; camelCase is split."""
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", str(header or ""))
    return " ".join(re.sub(r"[^a-z0-9#]+", " ", text.lower()).split())


def suggest(header: str) -> str | None:
    """The CRM field a header most likely is, or None when the CRM does not use it."""
    words = normalize_header(header)
    if not words or _MAILING & set(words.split()):
        return None
    field = _lookup.get(words)
    if field:
        return field
    # "Phone 2", "Cell 3", "Email 2": a known phrase followed by a number.
    stem = re.sub(r"\s*\d+$", "", words)
    if stem != words and _lookup.get(stem) in MULTIPLE:
        return _lookup[stem]
    return None


def source_detail(header: str) -> str | None:
    """A recognized source-only title, distinct from a CRM field suggestion."""
    words = normalize_header(header)
    owner = re.fullmatch(r"owner ((?:[2-9]|[1-9][0-9]+)) (first|last|full) name", words)
    if owner:
        return f"Owner {owner[1]} {owner[2]} name"
    return SOURCE_DETAILS.get(words)


def standard_key(header: str) -> str | None:
    """Stable key for an understood column, including columns kept only in source rows."""
    words = normalize_header(header)
    detail = source_detail(header)
    if detail:
        return re.sub(r"[^a-z0-9]+", "_", detail.lower()).strip("_")
    field = suggest(header)
    if not field:
        return None
    if words.startswith("owner 1 "):
        return "owner_1_" + field
    if words in {"alt phone", "alternate phone", "alternative phone"}:
        return "alternate_phone"
    numbered = re.search(r"\s(\d+)$", words)
    if numbered and field in MULTIPLE:
        return f"{field}_{numbered[1]}"
    return field


def standard_keys(headers: list[str]) -> list[str | None]:
    """Keep distinct columns even when two different headings mean the same field."""
    used: set[str] = set()
    result: list[str | None] = []
    for header in headers:
        base = standard_key(header)
        if not base:
            result.append(None)
            continue
        key = base
        suffix = 2
        while key in used:
            key = f"{base}_{suffix}"
            suffix += 1
        used.add(key)
        result.append(key)
    return result


def suggest_all(headers: list[str]) -> list[str | None]:
    """Suggestions for a whole header row: a field that cannot repeat (name, address...) goes to its first column only."""
    taken: set[str] = set()
    out: list[str | None] = []
    for header in headers:
        field = suggest(header)
        if field and field not in MULTIPLE:
            if field in taken:
                field = None
            else:
                taken.add(field)
        out.append(field)
    return out
