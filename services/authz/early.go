package main

// Build step 40 (D294): the switches (D104) an agency's owner may turn on early, knowing they may change. Staff still turn any
// switch with PUT /v1/orgs/{org}/features/{name}.

import (
	"log"
	"net/http"
	"slices"
)

type earlyFeature struct {
	Name        string `json:"name"`
	Title       string `json:"title"`
	Description string `json:"description"`
}

var earlyCatalog = []earlyFeature{
	{teamsV2, "New team rules", "Several leads per team, deputies, and team leads who invite into their own teams. This may still change."},
}

// earlyFeatures answers GET /v1/orgs/{org}/early-features and PUT …/{name} {on, actor_id, actor_second_step} (the owner only).
func (s *server) earlyFeatures(w http.ResponseWriter, r *http.Request) error {
	org, err := s.workspace(r)
	if err != nil {
		return err
	}
	ctx := r.Context()
	if r.Method == http.MethodPut {
		name := r.PathValue("name")
		if !slices.ContainsFunc(earlyCatalog, func(f earlyFeature) bool { return f.Name == name }) {
			return bad("That is not a feature owners can switch on early.")
		}
		var body struct {
			actor
			On bool `json:"on"`
		}
		if err := readJSON(w, r, &body); err != nil {
			return err
		}
		if err := s.mayManage(ctx, org, body.actor); err != nil {
			return err
		}
		f, err := s.rules.facts(ctx, body.ActorID, org)
		if err != nil {
			return store(err)
		}
		if !slices.Contains(f.roles, "owner") && !slices.Contains(f.roles, "solo") {
			return forbidden("Only the agency's owner switches early features on.")
		}
		if err := store(s.rules.setFeature(ctx, org, name, body.On)); err != nil {
			return err
		}
		log.Printf("INFO workspace %s: early feature %s turned %v by its owner", org, name, body.On)
	}
	on, err := s.rules.features(ctx, org)
	if err != nil {
		return store(err)
	}
	out := []map[string]any{}
	for _, f := range earlyCatalog {
		out = append(out, map[string]any{"name": f.Name, "title": f.Title, "description": f.Description,
			"on": slices.Contains(on, f.Name) || slices.Contains(s.cfg.featuresEverywhere, f.Name)})
	}
	writeJSON(w, http.StatusOK, map[string]any{"features": out})
	return nil
}
